import {CheckmarkCircleIcon, CloseIcon, LaunchIcon, TranslateIcon} from '@sanity/icons'
import {Badge, Box, Button, Card, Checkbox, Flex, Radio, Spinner, Stack, Text, useToast} from '@sanity/ui'
import {useEffect, useMemo, useRef, useState} from 'react'
import {useClient, useSchema} from 'sanity'

import {getBaseDocumentId} from '../core/ids'
import type {TranslationMode} from '../core/plan'
import {
  canTranslateDocument,
  checkLocalizationSetup,
  describeRequest,
  INSTALL_GUIDE_URL,
  languageOptions,
  languageProgress,
  PROJECT_TYPE_OPTIONS,
  projectTypeLabel,
  teamForRequest,
  validateTeam,
  type ProjectType,
  type TeamChoice,
} from './logic'
import type {TextUnitedStudioOptions} from './options'
import {describePending, summarizePending} from './summary'
import {TeamPicker} from './TeamPicker'
import {useTranslationData, type RequestRecord} from './useTranslationData'

const API_VERSION = '2025-02-19'

type Roles = Pick<TeamChoice, 'translator' | 'proofreader' | 'projectManager'>

function teamStorageKey(projectId: string, dataset: string) {
  return `textunited.team.${projectId}.${dataset}`
}

function readSavedRoles(key: string): Record<number, Roles> {
  try {
    return JSON.parse(window.localStorage.getItem(key) ?? '{}') as Record<number, Roles>
  } catch {
    return {}
  }
}

function saveRoles(key: string, team: TeamChoice[]) {
  try {
    const roles: Record<number, Roles> = {}
    for (const member of team) {
      if (member.translator || member.proofreader || member.projectManager) {
        roles[member.id] = {
          translator: member.translator,
          proofreader: member.proofreader,
          projectManager: member.projectManager,
        }
      }
    }
    window.localStorage.setItem(key, JSON.stringify(roles))
  } catch {
    // Remembering the team is a convenience only.
  }
}

function isRunning(request: RequestRecord | undefined): boolean {
  return request?.status === 'queued' || request?.status === 'running'
}

function formatTime(value: string | undefined): string {
  if (!value) return ''
  const date = new Date(value)
  const sameDay = date.toDateString() === new Date().toDateString()
  return sameDay
    ? date.toLocaleTimeString(undefined, {hour: '2-digit', minute: '2-digit'})
    : date.toLocaleDateString(undefined, {day: 'numeric', month: 'short'})
}

function ProgressBar(props: {value: number; complete: boolean}) {
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(props.value * 100)}
      style={{height: 4, borderRadius: 2, overflow: 'hidden', background: 'var(--card-border-color)'}}
    >
      <div
        style={{
          height: 4,
          width: `${Math.round(props.value * 100)}%`,
          background: props.complete
            ? 'var(--card-badge-positive-dot-color, #3ab667)'
            : 'var(--card-focus-ring-color, #556bfc)',
        }}
      />
    </div>
  )
}

/**
 * The TextUnited panel next to a document: what needs translation, progress per language, one
 * button to send, and the recent history. Used as a document inspector, and inside a dialog
 * where no document pane is available.
 */
export function TranslationPanel(props: {
  documentId: string
  documentType: string
  options: TextUnitedStudioOptions
  onClose?: () => void
}) {
  const {documentId, documentType, options} = props
  const client = useClient({apiVersion: API_VERSION})
  const toast = useToast()
  const data = useTranslationData(documentId, documentType, options)
  const {projectId: sanityProjectId, dataset} = client.config()
  const storageKey = teamStorageKey(String(sanityProjectId), String(dataset))

  const projectLanguages = data.state?.projectLanguages
  const hasProject = Boolean(data.state?.projectCustomId)
  const languages = useMemo(
    () => languageOptions(options.translation, projectLanguages),
    [options.translation, projectLanguages],
  )
  const [selected, setSelected] = useState<string[] | null>(null)
  useEffect(() => {
    // Preselect the project's languages once the status is known.
    if (!data.loading && selected === null) setSelected(projectLanguages ?? [])
  }, [data.loading, selected, projectLanguages])
  const chosen = (selected ?? []).filter((id) => languages.some((option) => option.id === id && option.available))

  const allowedTypes = options.projectTypes?.length ? options.projectTypes : (['outsourced', 'inHouse'] as ProjectType[])
  const [projectType, setProjectType] = useState<ProjectType>(
    options.defaultProjectType && allowedTypes.includes(options.defaultProjectType)
      ? options.defaultProjectType
      : allowedTypes[0] ?? 'outsourced',
  )
  const [team, setTeam] = useState<TeamChoice[]>([])
  const inHouse = !hasProject && projectType === 'inHouse'
  const teamError = inHouse ? validateTeam(team) : null

  const [showMore, setShowMore] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const progress = useMemo(
    () => languageProgress(data.state?.stateJson, projectLanguages),
    [data.state?.stateJson, projectLanguages],
  )
  const pending = useMemo(
    () =>
      data.targets
        ? summarizePending({
            units: data.units,
            targets: data.targets,
            state: data.translationState,
            languages: chosen,
          })
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.units, data.targets, data.translationState, chosen.join(',')],
  )
  const perLanguage = useMemo(
    () =>
      data.targets
        ? summarizePending({
            units: data.units,
            targets: data.targets,
            state: data.translationState,
            languages: languages.filter((option) => option.available).map((option) => option.id),
          }).byLanguage
        : {},
    [data.units, data.targets, data.translationState, languages],
  )

  // Tell the editor when reviewed translations arrive while the panel is open.
  const reviewedTotal = [...progress.values()].reduce((sum, entry) => sum + entry.reviewed, 0)
  const previousReviewed = useRef<number | null>(null)
  useEffect(() => {
    if (data.loading) return
    const previous = previousReviewed.current
    previousReviewed.current = reviewedTotal
    if (previous !== null && reviewedTotal > previous) {
      const added = reviewedTotal - previous
      toast.push({
        status: 'success',
        title: `${added} reviewed translation${added === 1 ? '' : 's'} added to the draft`,
      })
    }
  }, [reviewedTotal, data.loading, toast])

  const lastRequest = data.requests[0]
  const running = isRunning(lastRequest)
  const check = canTranslateDocument(options.translation, documentType, data.source)
  const schema = useSchema()
  const setupError = useMemo(
    () => checkLocalizationSetup(options.translation, documentType, schema.getTypeNames()),
    [options.translation, documentType, schema],
  )

  const send = async (mode: TranslationMode) => {
    setSubmitting(true)
    setSubmitError(null)
    const requestId = `textunited.request.${crypto.randomUUID()}`
    try {
      await client.create({
        _id: requestId,
        _type: 'textunited.translationRequest',
        documentId: getBaseDocumentId(documentId),
        languages: chosen,
        mode,
        status: 'queued',
        requestedAt: new Date().toISOString(),
        ...(hasProject ? {} : {projectType, ...(inHouse ? {team: teamForRequest(team)} : {})}),
      })
      if (inHouse) saveRoles(storageKey, team)
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Could not create the translation request')
      setSubmitting(false)
      return
    }
    fetch(`${options.handlerUrl.replace(/\/+$/, '')}/jobs`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({requestId}),
    }).catch(() => {
      setSubmitError(
        'The translation server could not be reached. The request is saved and can be processed later; check the handlerUrl setting and the server.',
      )
    })
    data.refresh()
    setSubmitting(false)
    setShowMore(false)
  }

  const projectLink =
    typeof data.state?.projectId === 'number' && options.projectUrl ? options.projectUrl(data.state.projectId) : null

  return (
    <Flex direction="column" height="fill" style={{overflow: 'auto'}}>
      <Card borderBottom paddingX={3} paddingY={2}>
        <Flex align="center" gap={2}>
          <Text size={1}>
            <TranslateIcon />
          </Text>
          <Box flex={1}>
            <Text size={1} weight="semibold">
              Translation
            </Text>
          </Box>
          {projectLink ? (
            <Button
              as="a"
              href={projectLink}
              target="_blank"
              rel="noreferrer"
              mode="bleed"
              fontSize={1}
              padding={2}
              icon={LaunchIcon}
              text="Open in TextUnited"
            />
          ) : null}
          {props.onClose ? (
            <Button mode="bleed" fontSize={1} padding={2} icon={CloseIcon} aria-label="Close" onClick={props.onClose} />
          ) : null}
        </Flex>
      </Card>

      <Stack space={4} padding={3}>
        {data.loading ? (
          <Flex justify="center" padding={4}>
            <Spinner muted />
          </Flex>
        ) : null}

        {setupError ? (
          <Card padding={3} radius={2} tone="critical">
            <Stack space={3}>
              <Text size={1} weight="semibold">
                Translation is not set up for this document type
              </Text>
              <Text size={1}>{setupError}</Text>
              <Text size={1}>
                <a href={INSTALL_GUIDE_URL} target="_blank" rel="noreferrer">
                  Read the installation guide
                </a>
              </Text>
            </Stack>
          </Card>
        ) : null}

        {!data.loading && !setupError && !check.allowed ? (
          <Card padding={3} radius={2} tone="caution">
            <Text size={1}>{check.reason}</Text>
          </Card>
        ) : null}

        {!data.loading && !setupError && check.allowed ? (
          <>
            {data.source && data.units.length === 0 ? (
              <Card padding={3} radius={2} tone="caution">
                <Text size={1}>
                  This document has no texts to translate. Fill in the {options.translation.sourceLanguage.title}{' '}
                  version, and check that its fields use localized field types (fieldLevel) or are
                  listed in the translation configuration (documentLevel).
                </Text>
              </Card>
            ) : null}

            {running ? (
              <Card padding={3} radius={2} tone="primary">
                <Flex align="center" gap={3}>
                  <Spinner muted />
                  <Text size={1}>Sending to TextUnited…</Text>
                </Flex>
              </Card>
            ) : lastRequest?.status === 'failed' ? (
              <Card padding={3} radius={2} tone="critical">
                <Text size={1}>{describeRequest(lastRequest)}</Text>
              </Card>
            ) : null}

            {data.error ? (
              <Card padding={3} radius={2} tone="critical">
                <Text size={1}>{data.error}</Text>
              </Card>
            ) : null}

            {!running && pending && chosen.length > 0 ? (
              pending.texts > 0 ? (
                <Card padding={3} radius={2} tone="caution">
                  <Stack space={2}>
                    <Text size={1} weight="semibold">
                      {pending.texts === 1 ? '1 text needs translation' : `${pending.texts} texts need translation`}
                    </Text>
                    <Text size={1} muted>
                      {describePending(pending)}
                    </Text>
                  </Stack>
                </Card>
              ) : (
                <Card padding={3} radius={2} tone="positive">
                  <Flex align="center" gap={2}>
                    <Text size={1}>
                      <CheckmarkCircleIcon />
                    </Text>
                    <Text size={1}>Everything has been sent to TextUnited</Text>
                  </Flex>
                </Card>
              )
            ) : null}

            <Stack space={3}>
              <Flex align="center" gap={2}>
                <Box flex={1}>
                  <Text size={1} weight="semibold">
                    Languages
                  </Text>
                </Box>
                {data.state?.projectType ? (
                  <Badge fontSize={0}>{projectTypeLabel(data.state.projectType)}</Badge>
                ) : null}
              </Flex>
              {languages.filter((option) => option.available).map((option) => {
                const entry = progress.get(option.id)
                const toSend = perLanguage[option.id] ?? 0
                const done = entry && entry.total > 0 && entry.reviewed === entry.total
                return (
                  <Stack key={option.id} space={2}>
                    <Flex align="center" gap={2} as="label">
                      <Checkbox
                        checked={chosen.includes(option.id)}
                        disabled={!option.available || running}
                        onChange={() =>
                          setSelected((current) =>
                            (current ?? []).includes(option.id)
                              ? (current ?? []).filter((id) => id !== option.id)
                              : [...(current ?? []), option.id],
                          )
                        }
                      />
                      <Box flex={1}>
                        <Text size={1} muted={!option.available}>
                          {option.title}
                        </Text>
                      </Box>
                      <Text size={0} muted>
                        {!option.available
                          ? 'Not in project'
                          : toSend > 0 && hasProject
                            ? `${toSend} to send`
                            : done
                              ? 'Reviewed'
                              : entry
                                ? `${entry.reviewed} of ${entry.total} reviewed`
                                : ''}
                      </Text>
                    </Flex>
                    {entry && entry.total > 0 ? (
                      <Box paddingLeft={4}>
                        <ProgressBar value={entry.reviewed / entry.total} complete={Boolean(done)} />
                      </Box>
                    ) : null}
                  </Stack>
                )
              })}
              {languages.some((option) => !option.available) ? (
                <Text size={0} muted>
                  Not in this project:{' '}
                  {languages
                    .filter((option) => !option.available)
                    .map((option) => option.title)
                    .join(', ')}
                  . A language cannot be added to an existing TextUnited project yet.
                </Text>
              ) : null}
            </Stack>

            {!hasProject && allowedTypes.length > 1 ? (
              <Stack space={3}>
                <Text size={1} weight="semibold">
                  Who translates
                </Text>
                {PROJECT_TYPE_OPTIONS.filter((option) => allowedTypes.includes(option.value)).map((option) => (
                  <Flex key={option.value} gap={2} as="label" align="flex-start">
                    <Radio
                      checked={projectType === option.value}
                      disabled={running}
                      name={`textunited-project-type-${documentId}`}
                      value={option.value}
                      onChange={() => setProjectType(option.value)}
                    />
                    <Stack space={2}>
                      <Text size={1}>{option.title}</Text>
                      <Text size={0} muted>
                        {option.description}
                      </Text>
                    </Stack>
                  </Flex>
                ))}
                {inHouse ? (
                  <TeamPicker
                    handlerUrl={options.handlerUrl}
                    team={team}
                    onChange={setTeam}
                    disabled={running}
                    savedRoles={readSavedRoles(storageKey)}
                  />
                ) : null}
              </Stack>
            ) : null}

            {submitError ? (
              <Card padding={3} radius={2} tone="critical">
                <Text size={1}>{submitError}</Text>
              </Card>
            ) : null}

            <Stack space={2}>
              <Button
                tone="primary"
                icon={TranslateIcon}
                loading={submitting}
                disabled={running || chosen.length === 0 || !pending || pending.texts === 0 || teamError !== null}
                text={
                  chosen.length === 0
                    ? 'Choose a language'
                    : teamError && team.length > 0
                      ? teamError
                      : !pending || pending.texts === 0
                        ? 'Nothing to send'
                        : `Send ${pending.texts === 1 ? '1 text' : `${pending.texts} texts`} to TextUnited`
                }
                onClick={() => void send('changed')}
              />
              {hasProject ? (
                <Button
                  mode="bleed"
                  fontSize={1}
                  text={showMore ? 'Fewer options' : 'More options'}
                  onClick={() => setShowMore((value) => !value)}
                />
              ) : null}
              {showMore ? (
                <Card padding={3} radius={2} border>
                  <Stack space={3}>
                    <Text size={1} muted>
                      Sends every text again for the chosen languages and replaces all their
                      translations, including ones edited by hand in Sanity.
                    </Text>
                    <Button
                      mode="ghost"
                      tone="critical"
                      text="Retranslate everything"
                      disabled={running || chosen.length === 0}
                      onClick={() => void send('all')}
                    />
                  </Stack>
                </Card>
              ) : null}
            </Stack>

            <Text size={0} muted>
              A machine translation is added to the draft right away. Reviewed translations replace
              it as translators confirm them in TextUnited. Publish the document to show them on the
              site.
            </Text>

            {data.requests.length > 0 ? (
              <Card borderTop paddingTop={3}>
                <Stack space={3}>
                  <Text size={1} weight="semibold">
                    History
                  </Text>
                  {data.requests.slice(0, 3).map((request) => (
                    <Flex key={request._id} gap={2}>
                      <Box style={{minWidth: 44}}>
                        <Text size={0} muted>
                          {formatTime(request._createdAt)}
                        </Text>
                      </Box>
                      <Box flex={1}>
                        <Text size={0} muted>
                          {describeRequest(request)}
                        </Text>
                      </Box>
                    </Flex>
                  ))}
                </Stack>
              </Card>
            ) : null}
          </>
        ) : null}
      </Stack>
    </Flex>
  )
}

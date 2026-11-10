import {CheckmarkCircleIcon, CloseIcon, LaunchIcon, TranslateIcon} from '@sanity/icons'
import {Badge, Box, Button, Card, Checkbox, Flex, Radio, Spinner, Stack, Text, useToast} from '@sanity/ui'
import {useEffect, useMemo, useRef, useState} from 'react'
import {useClient, useSchema} from 'sanity'

import {getBaseDocumentId} from '../core/ids'
import {activeProjects, projectForLanguage, projectLanguages, type ProjectRecord} from '../core/projects'
import type {TranslationMode} from '../core/plan'
import {
  canTranslateDocument,
  checkLanguageIds,
  checkLocalizationSetup,
  describeRequest,
  INSTALL_GUIDE_URL,
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
import {TextUnitedIcon} from './TextUnitedIcon'
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
 * button to send, the document's TextUnited projects and the recent history. Used as a document
 * inspector, and inside a dialog where no document pane is available.
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

  const {projects, archived, stopped} = data
  const active = useMemo(() => activeProjects(projects, stopped), [projects, stopped])
  const hasProject = projects.length > 0
  const languages = options.translation.targetLanguages
  const [selected, setSelected] = useState<string[] | null>(null)
  useEffect(() => {
    // Preselect the languages of the document's projects once the status is known.
    if (!data.loading && selected === null) setSelected(projectLanguages(active))
  }, [data.loading, selected, active])
  const chosen = (selected ?? []).filter(
    (id) => !stopped.includes(id) && languages.some((language) => language.id === id),
  )

  // A reset starts a new project for the chosen languages; the current ones are kept as they are.
  const [resetMode, setResetMode] = useState(false)
  const newLanguages = resetMode ? chosen : chosen.filter((id) => !projectForLanguage(projects, id))
  const needsNewProject = !hasProject || newLanguages.length > 0

  const allowedTypes = options.projectTypes?.length ? options.projectTypes : (['outsourced', 'inHouse'] as ProjectType[])
  const preferredType =
    projects[0]?.projectType && allowedTypes.includes(projects[0].projectType)
      ? projects[0].projectType
      : options.defaultProjectType && allowedTypes.includes(options.defaultProjectType)
        ? options.defaultProjectType
        : (allowedTypes[0] ?? 'outsourced')
  const [projectType, setProjectType] = useState<ProjectType | null>(null)
  const typeForNewProject = projectType ?? preferredType
  const [team, setTeam] = useState<TeamChoice[]>([])
  const inHouse = needsNewProject && typeForNewProject === 'inHouse'
  const teamError = inHouse ? validateTeam(team) : null

  const [showMore, setShowMore] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const progress = useMemo(
    () => languageProgress(data.translationState, active),
    [data.translationState, active],
  )
  const pending = useMemo(
    () =>
      data.targets
        ? summarizePending({
            units: data.units,
            targets: data.targets,
            state: data.translationState,
            languages: chosen,
            projects: resetMode ? [] : projects,
          })
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.units, data.targets, data.translationState, chosen.join(','), projects, resetMode],
  )
  const perLanguage = useMemo(
    () =>
      data.targets
        ? summarizePending({
            units: data.units,
            targets: data.targets,
            state: data.translationState,
            languages: languages.map((language) => language.id).filter((id) => !stopped.includes(id)),
            projects,
          }).byLanguage
        : {},
    [data.units, data.targets, data.translationState, languages, projects],
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
    () =>
      checkLocalizationSetup(options.translation, documentType, schema.getTypeNames()) ??
      checkLanguageIds(options.translation, documentType, data.source),
    [options.translation, documentType, schema, data.source],
  )

  const send = async (mode: TranslationMode, reset = false) => {
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
        ...(reset ? {reset: true} : {}),
        // The project type and team matter only when the request creates a project.
        ...(needsNewProject
          ? {projectType: typeForNewProject, ...(inHouse ? {team: teamForRequest(team)} : {})}
          : {}),
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
    setResetMode(false)
  }

  // Stop or resume a language: nothing goes to TextUnited, the server only updates the state.
  const [stopTarget, setStopTarget] = useState<string | null>(null)
  const changeLanguage = async (action: 'stop' | 'resume', language: string) => {
    setSubmitting(true)
    setSubmitError(null)
    const requestId = `textunited.request.${crypto.randomUUID()}`
    try {
      await client.create({
        _id: requestId,
        _type: 'textunited.translationRequest',
        documentId: getBaseDocumentId(documentId),
        languages: [language],
        mode: 'changed',
        action,
        status: 'queued',
        requestedAt: new Date().toISOString(),
      })
      await fetch(`${options.handlerUrl.replace(/\/+$/, '')}/jobs`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({requestId}),
      })
      setSelected((current) =>
        action === 'stop' ? (current ?? []).filter((id) => id !== language) : [...(current ?? []), language],
      )
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Could not change the language')
    }
    data.refresh()
    setSubmitting(false)
    setStopTarget(null)
    setShowMore(false)
  }

  const linkTo = (project: ProjectRecord) =>
    typeof project.projectId === 'number' && options.projectUrl ? options.projectUrl(project.projectId) : null
  const titleOf = (id: string) => languages.find((language) => language.id === id)?.title ?? id
  const listTitles = (ids: string[]) => ids.map(titleOf).join(', ')
  const headerLink = projects.length === 1 && projects[0] ? linkTo(projects[0]) : null

  const sendLabel = () => {
    if (chosen.length === 0) return 'Choose a language'
    if (teamError && team.length > 0) return teamError
    if (resetMode) return `Start a new project for ${chosen.length === 1 ? '1 language' : `${chosen.length} languages`}`
    if (!pending || pending.texts === 0) return 'Nothing to send'
    return `Send ${pending.texts === 1 ? '1 text' : `${pending.texts} texts`} to TextUnited`
  }

  return (
    <Flex direction="column" height="fill" style={{overflow: 'auto'}}>
      <Card borderBottom paddingX={3} paddingY={2}>
        <Flex align="center" gap={2}>
          <Text size={1}>
            <TextUnitedIcon />
          </Text>
          <Box flex={1}>
            <Text size={1} weight="semibold">
              TextUnited
            </Text>
          </Box>
          {headerLink ? (
            <Button
              as="a"
              href={headerLink}
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

            {!running && !resetMode && pending && chosen.length > 0 ? (
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
              <Text size={1} weight="semibold">
                Languages
              </Text>
              {languages.map((language) => {
                const entry = progress.get(language.id)
                const inProject = Boolean(projectForLanguage(projects, language.id))
                const toSend = perLanguage[language.id] ?? 0
                const done = entry && entry.total > 0 && entry.reviewed === entry.total
                if (stopped.includes(language.id)) {
                  return (
                    <Flex key={language.id} align="center" gap={2}>
                      <Checkbox checked={false} disabled />
                      <Box flex={1}>
                        <Text size={1} muted>
                          {language.title}
                        </Text>
                      </Box>
                      <Text size={0} muted>
                        Stopped
                      </Text>
                      <Button
                        mode="bleed"
                        fontSize={0}
                        padding={1}
                        text="Resume"
                        disabled={running || submitting}
                        onClick={() => void changeLanguage('resume', language.id)}
                      />
                    </Flex>
                  )
                }
                return (
                  <Stack key={language.id} space={2}>
                    <Flex align="center" gap={2} as="label">
                      <Checkbox
                        checked={chosen.includes(language.id)}
                        disabled={running}
                        onChange={() =>
                          setSelected((current) =>
                            (current ?? []).includes(language.id)
                              ? (current ?? []).filter((id) => id !== language.id)
                              : [...(current ?? []), language.id],
                          )
                        }
                      />
                      <Box flex={1}>
                        <Text size={1}>{language.title}</Text>
                      </Box>
                      <Text size={0} muted>
                        {hasProject && !inProject
                          ? 'Not ordered yet'
                          : toSend > 0 && inProject
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
            </Stack>

            {hasProject && !resetMode && newLanguages.length > 0 ? (
              <Card padding={3} radius={2} tone="primary">
                <Text size={1}>
                  {listTitles(newLanguages)} {newLanguages.length === 1 ? 'is' : 'are'} ordered as a new
                  TextUnited project. The current {projects.length === 1 ? 'project stays' : 'projects stay'} as{' '}
                  {projects.length === 1 ? 'it is' : 'they are'}.
                </Text>
              </Card>
            ) : null}

            {resetMode ? (
              <Card padding={3} radius={2} tone="caution">
                <Stack space={3}>
                  <Text size={1} weight="semibold">
                    Start a new TextUnited project
                  </Text>
                  <Text size={1}>
                    Every text of this document is sent again, for the chosen languages, to a new
                    project. The current {projects.length === 1 ? 'project stays' : 'projects stay'} in
                    TextUnited as {projects.length === 1 ? 'it is' : 'they are'}, but this document no
                    longer follows {projects.length === 1 ? 'it' : 'them'}. Translations already in
                    Sanity are kept.
                  </Text>
                  <Button mode="bleed" fontSize={1} text="Cancel" onClick={() => setResetMode(false)} />
                </Stack>
              </Card>
            ) : null}

            {needsNewProject && allowedTypes.length > 1 ? (
              <Stack space={3}>
                <Text size={1} weight="semibold">
                  {hasProject ? 'Who translates the new project' : 'Who translates'}
                </Text>
                {PROJECT_TYPE_OPTIONS.filter((option) => allowedTypes.includes(option.value)).map((option) => (
                  <Flex key={option.value} gap={2} as="label" align="flex-start">
                    <Radio
                      checked={typeForNewProject === option.value}
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

            {stopTarget ? (
              <Card padding={3} radius={2} tone="caution">
                <Stack space={3}>
                  <Text size={1} weight="semibold">
                    Stop translating {titleOf(stopTarget)}?
                  </Text>
                  <Text size={1}>
                    Changes of this document are no longer sent for {titleOf(stopTarget)}, and
                    translations from TextUnited are no longer written or restored. The language
                    stays in its TextUnited project, where translators may still work on it; ask your
                    project manager if it should be cancelled. You can resume it at any time.
                  </Text>
                  <Flex gap={2}>
                    <Button
                      tone="caution"
                      text={`Stop ${titleOf(stopTarget)}`}
                      loading={submitting}
                      onClick={() => void changeLanguage('stop', stopTarget)}
                    />
                    <Button mode="bleed" text="Cancel" onClick={() => setStopTarget(null)} />
                  </Flex>
                </Stack>
              </Card>
            ) : null}

            <Stack space={2}>
              <Button
                tone={resetMode ? 'caution' : 'primary'}
                icon={TranslateIcon}
                loading={submitting}
                disabled={
                  running ||
                  chosen.length === 0 ||
                  teamError !== null ||
                  (!resetMode && (!pending || pending.texts === 0))
                }
                text={sendLabel()}
                onClick={() => void send('changed', resetMode)}
              />
              {hasProject && !resetMode ? (
                <Button
                  mode="bleed"
                  fontSize={1}
                  text={showMore ? 'Fewer options' : 'More options'}
                  onClick={() => setShowMore((value) => !value)}
                />
              ) : null}
              {showMore && !resetMode ? (
                <Card padding={3} radius={2} border>
                  <Stack space={4}>
                    <Stack space={3}>
                      <Text size={1} muted>
                        Sends every text again for the chosen languages and replaces all their
                        translations, including ones edited by hand in Sanity.
                      </Text>
                      <Button
                        mode="ghost"
                        tone="critical"
                        text="Retranslate everything"
                        disabled={running || chosen.length === 0 || newLanguages.length > 0}
                        onClick={() => void send('all')}
                      />
                    </Stack>
                    {projectLanguages(active).length > 0 ? (
                      <Stack space={3}>
                        <Text size={1} muted>
                          Stop translating a language on this document: nothing is sent, written or
                          restored for it any more. Its texts in Sanity stay until you remove them.
                        </Text>
                        <Flex gap={2} wrap="wrap">
                          {projectLanguages(active).map((id) => (
                            <Button
                              key={id}
                              mode="ghost"
                              fontSize={1}
                              text={`Stop ${titleOf(id)}`}
                              disabled={running}
                              onClick={() => {
                                setStopTarget(id)
                                setShowMore(false)
                              }}
                            />
                          ))}
                        </Flex>
                      </Stack>
                    ) : null}
                    <Stack space={3}>
                      <Text size={1} muted>
                        Starts over with a new TextUnited project, for example to change who
                        translates. Every text is sent again.
                      </Text>
                      <Button
                        mode="ghost"
                        text="Start a new TextUnited project"
                        disabled={running}
                        onClick={() => {
                          setResetMode(true)
                          setShowMore(false)
                        }}
                      />
                    </Stack>
                  </Stack>
                </Card>
              ) : null}
            </Stack>

            <Text size={0} muted>
              A machine translation is added to the draft right away. Reviewed translations replace
              it as translators confirm them in TextUnited. Publish the document to show them on the
              site.
            </Text>

            {projects.length > 1 || archived.length > 0 ? (
              <Card borderTop paddingTop={3}>
                <Stack space={3}>
                  <Text size={1} weight="semibold">
                    TextUnited projects
                  </Text>
                  {[...projects.map((project) => ({project, old: false})), ...archived.map((project) => ({project, old: true}))].map(
                    ({project, old}) => {
                      const link = linkTo(project)
                      return (
                        <Flex key={project.customId} gap={2} align="center">
                          <Box flex={1}>
                            <Text size={0} muted={old}>
                              {listTitles(project.languages)}
                              {project.projectType ? ` · ${projectTypeLabel(project.projectType)}` : ''}
                              {old ? ' · replaced' : ''}
                            </Text>
                          </Box>
                          {link ? (
                            <Text size={0}>
                              <a href={link} target="_blank" rel="noreferrer">
                                Open
                              </a>
                            </Text>
                          ) : null}
                        </Flex>
                      )
                    },
                  )}
                </Stack>
              </Card>
            ) : null}

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

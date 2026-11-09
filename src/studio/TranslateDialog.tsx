import {Badge, Box, Button, Card, Checkbox, Flex, Grid, Radio, Spinner, Stack, Text} from '@sanity/ui'
import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {useClient} from 'sanity'

import type {TranslationMode} from '../core/plan'
import {
  defaultLanguages,
  describeRequest,
  languageOptions,
  languageProgress,
  MODE_OPTIONS,
  PROJECT_TYPE_OPTIONS,
  projectTypeLabel,
  STATUS_QUERY,
  teamForRequest,
  validateTeam,
  type ProjectType,
  type TeamChoice,
  type TranslationStatusData,
} from './logic'
import type {TextUnitedStudioOptions} from './options'
import {TeamPicker} from './TeamPicker'

const API_VERSION = '2025-02-19'
const POLL_INTERVAL_MS = 2000

function isRunning(status: TranslationStatusData | null): boolean {
  const value = status?.lastRequest?.status
  return value === 'queued' || value === 'running'
}

export function TranslateDialog(props: {documentId: string; options: TextUnitedStudioOptions}) {
  const {documentId, options} = props
  const client = useClient({apiVersion: API_VERSION})
  const [status, setStatus] = useState<TranslationStatusData | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [languages, setLanguages] = useState<string[] | null>(null)
  const [mode, setMode] = useState<TranslationMode>('missing')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const allowedTypes = options.projectTypes?.length ? options.projectTypes : (['outsourced', 'inHouse'] as ProjectType[])
  const [projectType, setProjectType] = useState<ProjectType>(
    options.defaultProjectType && allowedTypes.includes(options.defaultProjectType)
      ? options.defaultProjectType
      : allowedTypes[0] ?? 'outsourced',
  )
  const [team, setTeam] = useState<TeamChoice[]>([])
  const mounted = useRef(true)

  const load = useCallback(async () => {
    try {
      const data = await client.fetch<TranslationStatusData>(STATUS_QUERY, {
        documentId,
        stateId: `textunited.state.${documentId}`,
      })
      if (mounted.current) {
        setStatus(data)
        setLoadError(null)
      }
    } catch (error) {
      if (mounted.current) setLoadError(error instanceof Error ? error.message : 'Could not load the status')
    }
  }, [client, documentId])

  useEffect(() => {
    mounted.current = true
    void load()
    return () => {
      mounted.current = false
    }
  }, [load])

  // Follow a request until the server has finished it.
  useEffect(() => {
    if (!isRunning(status)) return undefined
    const timer = setTimeout(() => void load(), POLL_INTERVAL_MS)
    return () => clearTimeout(timer)
  }, [status, load])

  const projectLanguages = status?.state?.projectLanguages
  const options_ = useMemo(
    () => languageOptions(options.translation, projectLanguages),
    [options.translation, projectLanguages],
  )
  // Pick the default languages once the status is known.
  useEffect(() => {
    if (status && languages === null) setLanguages(defaultLanguages(options_, projectLanguages))
  }, [status, languages, options_, projectLanguages])

  const selected = languages ?? []
  const available = options_.filter((option) => option.available)
  const progress = useMemo(
    () => languageProgress(status?.state?.stateJson, status?.state?.projectLanguages),
    [status?.state?.stateJson, status?.state?.projectLanguages],
  )
  const toggle = (id: string) =>
    setLanguages((current) =>
      (current ?? []).includes(id) ? (current ?? []).filter((value) => value !== id) : [...(current ?? []), id],
    )

  const hasProject = Boolean(status?.state?.projectCustomId)
  const inHouse = !hasProject && projectType === 'inHouse'
  const teamError = inHouse ? validateTeam(team) : null

  const submit = async () => {
    setSubmitting(true)
    setSubmitError(null)
    const requestId = `textunited.request.${crypto.randomUUID()}`
    try {
      await client.create({
        _id: requestId,
        _type: 'textunited.translationRequest',
        documentId,
        languages: selected,
        mode,
        status: 'queued',
        requestedAt: new Date().toISOString(),
        // The project type and team matter only when the request creates the project.
        ...(hasProject ? {} : {projectType, ...(inHouse ? {team: teamForRequest(team)} : {})}),
      })
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Could not create the translation request')
      setSubmitting(false)
      return
    }

    // The server answers when the request is finished; the dialog follows the request document
    // meanwhile, so the editor can close it at any time.
    fetch(`${options.handlerUrl.replace(/\/+$/, '')}/jobs`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({requestId}),
    }).catch(() => {
      if (mounted.current) {
        setSubmitError(
          'The translation server could not be reached. The request is saved and can be processed later; check the handlerUrl setting and the server.',
        )
      }
    })
    await load()
    if (mounted.current) setSubmitting(false)
  }

  if (!status && !loadError) {
    return (
      <Flex align="center" justify="center" padding={5}>
        <Spinner muted />
      </Flex>
    )
  }

  const running = isRunning(status)
  const sourceTitle = options.translation.sourceLanguage.title

  return (
    <Stack space={4} padding={4}>
      <Card padding={3} radius={2} tone={status?.lastRequest?.status === 'failed' ? 'critical' : 'transparent'} border>
        <Stack space={3}>
          <Flex gap={2} align="center" wrap="wrap">
            <Text size={1} weight="semibold">
              Status
            </Text>
            {status?.state?.projectCustomId ? (
              <>
                <Badge tone="primary">TextUnited project {status.state.projectCustomId}</Badge>
                {status.state.projectType ? <Badge>{projectTypeLabel(status.state.projectType)}</Badge> : null}
              </>
            ) : (
              <Badge>No TextUnited project yet</Badge>
            )}
            {status?.state?.pending ? <Badge tone="caution">Translators may still update it</Badge> : null}
            {running ? <Spinner muted /> : null}
          </Flex>
          <Text size={1} muted>
            {loadError ?? describeRequest(status?.lastRequest ?? null)}
          </Text>
        </Stack>
      </Card>

      <Stack space={3}>
        <Flex align="center" justify="space-between" gap={2}>
          <Text size={1} weight="semibold">
            Target languages
          </Text>
          <Flex gap={1}>
            <Button
              mode="bleed"
              fontSize={1}
              padding={2}
              text="All"
              disabled={running}
              onClick={() => setLanguages(available.map((option) => option.id))}
            />
            <Button mode="bleed" fontSize={1} padding={2} text="None" disabled={running} onClick={() => setLanguages([])} />
          </Flex>
        </Flex>
        <Grid columns={[1, 2]} gap={2}>
          {options_.map((option) => {
            const languageState = progress.get(option.id)
            return (
              <Card key={option.id} padding={2} radius={2} tone={selected.includes(option.id) ? 'primary' : 'transparent'} border>
                <Flex align="center" gap={2} as="label">
                  <Checkbox
                    checked={selected.includes(option.id)}
                    disabled={!option.available || running}
                    onChange={() => toggle(option.id)}
                  />
                  <Box flex={1}>
                    <Text size={1} muted={!option.available}>
                      {option.title}
                    </Text>
                  </Box>
                  {!option.available ? (
                    <Badge fontSize={0}>Not in project</Badge>
                  ) : languageState ? (
                    <Badge
                      fontSize={0}
                      tone={languageState.reviewed === languageState.total ? 'positive' : 'caution'}
                      title="Texts confirmed by translators in TextUnited"
                    >
                      {languageState.reviewed}/{languageState.total} reviewed
                    </Badge>
                  ) : null}
                </Flex>
              </Card>
            )
          })}
        </Grid>
        <Text size={1} muted>
          {selected.length === 0
            ? 'No target languages selected'
            : `${selected.length} target language${selected.length === 1 ? '' : 's'}`}
        </Text>
        {options_.some((option) => !option.available) ? (
          <Text size={1} muted>
            Languages marked “Not in project” cannot be added to this document’s TextUnited project yet.
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
                name="textunited-project-type"
                value={option.value}
                onChange={() => setProjectType(option.value)}
              />
              <Stack space={2}>
                <Text size={1}>{option.title}</Text>
                <Text size={1} muted>
                  {option.description}
                </Text>
              </Stack>
            </Flex>
          ))}
          {inHouse ? (
            <Box paddingLeft={4}>
              <Stack space={3}>
                <TeamPicker handlerUrl={options.handlerUrl} team={team} onChange={setTeam} disabled={running} />
                {team.length > 0 && teamError ? (
                  <Text size={1} muted>
                    {teamError}
                  </Text>
                ) : null}
              </Stack>
            </Box>
          ) : null}
        </Stack>
      ) : null}

      <Stack space={3}>
        <Text size={1} weight="semibold">
          What to translate
        </Text>
        {MODE_OPTIONS.map((option) => (
          <Flex key={option.value} gap={2} as="label" align="flex-start">
            <Radio
              checked={mode === option.value}
              disabled={running}
              name="textunited-mode"
              value={option.value}
              onChange={() => setMode(option.value)}
            />
            <Stack space={2}>
              <Text size={1}>{option.title}</Text>
              <Text size={1} muted>
                {option.description}
              </Text>
            </Stack>
          </Flex>
        ))}
      </Stack>

      <Card padding={3} radius={2} tone="primary">
        <Text size={1}>
          Texts are sent from the {sourceTitle} version to TextUnited, where translators review them. A
          machine translation appears in the draft right away; reviewed translations replace it as
          translators confirm them. Publish the document to make translations visible on the site.
        </Text>
      </Card>

      {submitError ? (
        <Card padding={3} radius={2} tone="critical">
          <Text size={1}>{submitError}</Text>
        </Card>
      ) : null}

      <Flex justify="flex-end">
        <Button
          text={running ? 'Translating…' : 'Translate'}
          tone="primary"
          disabled={selected.length === 0 || running || submitting || teamError !== null}
          loading={submitting}
          onClick={() => void submit()}
        />
      </Flex>
    </Stack>
  )
}

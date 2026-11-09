import {Badge, Box, Card, Checkbox, Flex, Spinner, Stack, Text} from '@sanity/ui'
import {useEffect, useState} from 'react'
import {useClient} from 'sanity'

import type {TeamChoice} from './logic'

const API_VERSION = '2025-02-19'

type Candidate = Omit<TeamChoice, 'translator' | 'proofreader' | 'projectManager'>

/**
 * Lists the people of the TextUnited account and lets the editor give them roles.
 * The list comes from the server; the Studio first creates a short-lived query document,
 * which proves the editor may write to the dataset.
 */
export function TeamPicker(props: {
  handlerUrl: string
  team: TeamChoice[]
  onChange: (team: TeamChoice[]) => void
  disabled?: boolean
}) {
  const {handlerUrl, team, onChange, disabled} = props
  const client = useClient({apiVersion: API_VERSION})
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(team.length === 0)

  useEffect(() => {
    if (team.length > 0) return undefined
    let cancelled = false
    const load = async () => {
      const queryId = `textunited.teamQuery.${crypto.randomUUID()}`
      try {
        await client.create({_id: queryId, _type: 'textunited.teamQuery', requestedAt: new Date().toISOString()})
        const response = await fetch(`${handlerUrl.replace(/\/+$/, '')}/team`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({queryId}),
        })
        const body = (await response.json()) as {members?: Candidate[]; message?: string}
        if (!response.ok) throw new Error(body.message ?? `The server answered ${response.status}`)
        if (!cancelled) {
          onChange(
            (body.members ?? []).map((member) => ({
              ...member,
              translator: false,
              proofreader: false,
              projectManager: false,
            })),
          )
        }
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : 'Could not load the team')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
    // Load once, when the picker opens.
  }, [])

  if (loading) {
    return (
      <Flex align="center" gap={2}>
        <Spinner muted />
        <Text size={1} muted>
          Loading people from TextUnited…
        </Text>
      </Flex>
    )
  }
  if (error) {
    return (
      <Card padding={3} radius={2} tone="critical">
        <Text size={1}>{error}</Text>
      </Card>
    )
  }
  if (team.length === 0) {
    return (
      <Text size={1} muted>
        Nobody in this TextUnited account can be added to a team.
      </Text>
    )
  }

  const toggle = (id: number, role: 'translator' | 'proofreader' | 'projectManager') =>
    onChange(team.map((member) => (member.id === id ? {...member, [role]: !member[role]} : member)))

  return (
    <Stack space={3}>
      {team.map((member) => (
        <Card key={member.id} padding={2} radius={2} border>
          <Stack space={2}>
            <Flex gap={2} align="center" wrap="wrap">
              <Text size={1} weight="medium">
                {member.name}
              </Text>
              {member.kind === 'collaborator' ? <Badge>Collaborator</Badge> : null}
              <Text size={0} muted>
                {member.username}
              </Text>
            </Flex>
            <Flex gap={4} wrap="wrap">
              {(
                [
                  ['translator', 'Translator'],
                  ['proofreader', 'Proofreader'],
                  ['projectManager', 'Project manager'],
                ] as const
              ).map(([role, label]) => (
                <Flex key={role} gap={2} align="center" as="label">
                  <Checkbox checked={member[role]} disabled={disabled} onChange={() => toggle(member.id, role)} />
                  <Box>
                    <Text size={1}>{label}</Text>
                  </Box>
                </Flex>
              ))}
            </Flex>
          </Stack>
        </Card>
      ))}
    </Stack>
  )
}

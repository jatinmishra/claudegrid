import { expect, test } from 'claude-code/testing'
import { jiraKey, jiraKeyFromBranch, jiraKeyFromPrompt, summarizeArgs, redact, fmtTokens, fmtDur, cacheHit, mcpServer } from '../hooks/lib.ts'

test('jira key from branch names', () => {
  expect(jiraKeyFromBranch('feature/ABC-123-login-fix')).toBe('ABC-123')
  expect(jiraKeyFromBranch('abc-45-refactor')).toBe('ABC-45')
  expect(jiraKeyFromBranch('bugfix/IOS-9')).toBe('IOS-9')
})

test('jira key ignores non-project prefixes', () => {
  expect(jiraKeyFromBranch('release-2024')).toBe(null)
  expect(jiraKeyFromBranch('fix-12')).toBe(null)
  expect(jiraKeyFromBranch('main')).toBe(null)
})

test('branch beats prompt, prompt is the fallback', () => {
  expect(jiraKey('feature/ABC-1-x', 'work on XYZ-2')).toBe('ABC-1')
  expect(jiraKey('main', 'work on XYZ-2')).toBe('XYZ-2')
  expect(jiraKeyFromPrompt('no card here')).toBe(null)
})

test('args are summarized and redacted', () => {
  expect(summarizeArgs({ command: 'curl -H "Authorization: Bearer abc123" x' })).toContain('[redacted]')
  expect(summarizeArgs({ tool: 'Read', file_path: '/a/b.txt' })).toBe('/a/b.txt')
  expect(redact('API_KEY=supersecret')).toBe('API_KEY=[redacted]')
})

test('formatters', () => {
  expect(fmtTokens(950)).toBe('950')
  expect(fmtTokens(12400)).toBe('12.4k')
  expect(fmtDur(75000)).toBe('01:15')
  expect(cacheHit(100, 900, 0)).toBe(0.9)
  expect(mcpServer('mcp__Notes__search')).toBe('Notes')
  expect(mcpServer('Bash')).toBe(null)
})

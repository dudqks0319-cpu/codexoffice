import { describe, expect, it } from 'vitest'
import { JobLifecycle } from '@genoffice/agent-core'
import { acceptsSheetsJobCallback } from '../src/renderer/ai-job'

const lifecycle = () =>
  new JobLifecycle({
    jobId: 'sheets-job',
    appKind: 'sheets',
    model: 'gpt-5.6-pro',
    reasoning: 'max',
    sources: [{ locator: 'workbook:test.xlsx', hash: 'sha256:test' }],
    maximumBudget: { amount: 8_192, unit: 'tokens' },
  })

describe('Sheets AI callback gate', () => {
  it('rejects a callback after Stop invalidates its generation', () => {
    const job = lifecycle()
    job.transition('PREPARING')
    job.transition('RUNNING')
    expect(acceptsSheetsJobCallback(job, 4, 4)).toBe(true)
    expect(acceptsSheetsJobCallback(job, 4, 5)).toBe(false)
    job.transition('CANCELLED')
    expect(acceptsSheetsJobCallback(job, 4, 4)).toBe(false)
  })
})

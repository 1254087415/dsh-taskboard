// @vitest-environment node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { builtinTemplateContent } from '../src/shared/builtin-templates.ts'

describe('shipped client wrapper', () => {
  it('retains the actual bundled template prompt without injected indentation', () => {
    const wrapped = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
    // Evaluate the literal array + join expression emitted for this template,
    // rather than the source template which was never affected by wrapping.
    const prompt = wrapped.match(/prompt:(\[`实现以上新功能并按序交接：`[\s\S]*?\]\.join\(`[\s\S]*?`\))/)?.[1]
    expect(prompt).toBeDefined()
    expect(Function(`return ${prompt}`)()).toBe(builtinTemplateContent('tpl-feature', 'zh')!.task.prompt)
  })
})

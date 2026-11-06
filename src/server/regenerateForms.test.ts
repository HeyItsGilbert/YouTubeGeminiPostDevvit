import { describe, expect, it } from 'vitest';
import type { Form } from '@devvit/web/shared';
import { MODEL_DEFAULT_THINKING_LEVEL, buildStep1Form, buildStep2Form } from './regenerateForms.js';
import type { GeminiModel } from '../types.js';

const MODELS: GeminiModel[] = [
  { id: 'gemini-flash-latest', name: 'Gemini Flash Latest', thinkingLevels: ['none', 'low', 'high'] },
  { id: 'gemini-pro-latest', name: 'Gemini Pro Latest', thinkingLevels: [] },
];

function fieldByName(form: Form, name: string) {
  for (const field of form.fields) {
    if ('name' in field && field.name === name) return field;
    if (field.type === 'group') {
      const nested = field.fields.find((f) => 'name' in f && f.name === name);
      if (nested) return nested;
    }
  }
  return undefined;
}

describe('buildStep1Form', () => {
  it('pre-fills the system prompt as a required paragraph field', () => {
    const form = buildStep1Form({ systemPrompt: 'Be concise.', models: MODELS, selectedModel: 'gemini-flash-latest' });
    const field = fieldByName(form, 'systemPrompt');
    expect(field).toMatchObject({ type: 'paragraph', defaultValue: 'Be concise.', required: true });
  });

  it('offers every catalog model, pre-selecting the configured one, inside an Advanced group', () => {
    const form = buildStep1Form({ systemPrompt: 'x', models: MODELS, selectedModel: 'gemini-pro-latest' });
    const group = form.fields.find((f) => f.type === 'group');
    expect(group).toBeDefined();
    expect(group?.label).toBe('Advanced (optional)');

    const modelField = fieldByName(form, 'model');
    expect(modelField?.type).toBe('select');
    if (modelField?.type !== 'select') throw new Error('expected select field');
    expect(modelField.options.map((o) => o.value)).toEqual(['gemini-flash-latest', 'gemini-pro-latest']);
    expect(modelField.defaultValue).toEqual(['gemini-pro-latest']);
  });

  it('includes an off-by-default toggle to choose a thinking level for this run', () => {
    const form = buildStep1Form({ systemPrompt: 'x', models: MODELS, selectedModel: 'gemini-flash-latest' });
    const field = fieldByName(form, 'chooseThinkingLevel');
    expect(field).toMatchObject({ type: 'boolean', defaultValue: false });
  });

  it("warns about the ~10 minute submission window", () => {
    const form = buildStep1Form({ systemPrompt: 'x', models: MODELS, selectedModel: 'gemini-flash-latest' });
    expect(form.description).toMatch(/10 minute/i);
    expect(form.description).toMatch(/retry|try again/i);
  });
});

describe('buildStep2Form', () => {
  it("offers 'Model default' plus the model's accepted levels", () => {
    const form = buildStep2Form({ levels: ['none', 'low', 'high'] });
    const field = fieldByName(form, 'thinkingLevel');
    expect(field?.type).toBe('select');
    if (field?.type !== 'select') throw new Error('expected select field');
    expect(field.options.map((o) => o.value)).toEqual([MODEL_DEFAULT_THINKING_LEVEL, 'none', 'low', 'high']);
    expect(field.defaultValue).toEqual([MODEL_DEFAULT_THINKING_LEVEL]);
  });

  it("offers only 'Model default' for a model with no catalogued levels", () => {
    const form = buildStep2Form({ levels: [] });
    const field = fieldByName(form, 'thinkingLevel');
    if (field?.type !== 'select') throw new Error('expected select field');
    expect(field.options.map((o) => o.value)).toEqual([MODEL_DEFAULT_THINKING_LEVEL]);
  });
});

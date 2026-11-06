import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHOICE,
  buildConfigureBotForm,
  buildThinkingLevelForm,
  configureBotDraftKey,
  customizeThinkingField,
  decideConfigureBotSubmission,
  decideThinkingLevelSubmission,
  firstSelectValue,
  getGeminiChoice,
  modelSelectField,
  thinkingLevelSelectField,
  type GeminiChoice,
} from './configureBot.js';
import { DEFAULT_GEMINI_MODEL } from '../geminiModels.js';

/** Map-backed fake Redis — mirrors the `createFakeContext` style used by
 * checkerSchedule.test.ts, scoped to just `get`. */
function fakeRedis(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return { get: async (key: string) => store.get(key) };
}

describe('getGeminiChoice', () => {
  it('defaults to DEFAULT_GEMINI_MODEL with no thinking level when nothing is stored', async () => {
    const choice = await getGeminiChoice(fakeRedis());
    expect(choice).toEqual({ model: DEFAULT_GEMINI_MODEL, isDefaultModel: true, thinkingLevel: undefined });
  });

  it('reports the stored model and resolves a thinking level it accepts', async () => {
    const choice = await getGeminiChoice(fakeRedis({ gemini_model: 'gemini-pro-latest', gemini_thinking_level: 'high' }));
    expect(choice).toEqual({ model: 'gemini-pro-latest', isDefaultModel: false, thinkingLevel: 'high' });
  });

  it('drops a stored level the stored model does not accept', async () => {
    // gemini-pro-latest's catalog levels are low/medium/high — "none" isn't one of them.
    const choice = await getGeminiChoice(fakeRedis({ gemini_model: 'gemini-pro-latest', gemini_thinking_level: 'none' }));
    expect(choice.thinkingLevel).toBeUndefined();
  });
});

describe('firstSelectValue', () => {
  it('returns the first element of a select value array', () => {
    expect(firstSelectValue(['2'])).toBe('2');
  });

  it('returns undefined for an empty or missing array', () => {
    expect(firstSelectValue([])).toBeUndefined();
    expect(firstSelectValue(undefined)).toBeUndefined();
  });
});

describe('modelSelectField', () => {
  it('offers a Recommended option selected by default when no model is stored', () => {
    const field = modelSelectField(null) as { options: { label: string; value: string }[]; defaultValue: string[] };
    expect(field.options[0]).toEqual(expect.objectContaining({ value: DEFAULT_CHOICE }));
    expect(field.options[0]?.label).toContain('Recommended');
    expect(field.defaultValue).toEqual([DEFAULT_CHOICE]);
  });

  it('preselects the currently stored catalog model', () => {
    const field = modelSelectField('gemini-pro-latest') as { defaultValue: string[] };
    expect(field.defaultValue).toEqual(['gemini-pro-latest']);
  });

  it('keeps a no-longer-listed model selectable so saving never silently switches it', () => {
    const field = modelSelectField('gemini-retired-model') as { options: { value: string }[]; defaultValue: string[] };
    expect(field.options.some(o => o.value === 'gemini-retired-model')).toBe(true);
    expect(field.defaultValue).toEqual(['gemini-retired-model']);
  });
});

describe('customizeThinkingField', () => {
  it('carries the default value through', () => {
    expect(customizeThinkingField(true)).toEqual(
      expect.objectContaining({ type: 'boolean', name: 'customizeThinking', defaultValue: true })
    );
    expect(customizeThinkingField(false)).toEqual(expect.objectContaining({ defaultValue: false }));
  });
});

describe('thinkingLevelSelectField', () => {
  it('offers Model default plus every level the given model accepts', () => {
    const field = thinkingLevelSelectField('gemini-pro-latest', undefined) as {
      options: { label: string; value: string }[];
      defaultValue: string[];
    };
    expect(field.options.map(o => o.value)).toEqual([DEFAULT_CHOICE, 'low', 'medium', 'high']);
    expect(field.defaultValue).toEqual([DEFAULT_CHOICE]);
  });

  it('preselects the current level when one is given', () => {
    const field = thinkingLevelSelectField('gemini-pro-latest', 'medium') as { defaultValue: string[] };
    expect(field.defaultValue).toEqual(['medium']);
  });
});

describe('buildConfigureBotForm', () => {
  it('requires the API key field only when none is saved', () => {
    const withKey = buildConfigureBotForm({ hasApiKey: true, currentSlot: 1, storedModel: null, hasThinkingLevel: false });
    const withoutKey = buildConfigureBotForm({ hasApiKey: false, currentSlot: 1, storedModel: null, hasThinkingLevel: false });
    expect(withKey.fields[0]).toEqual(expect.objectContaining({ name: 'apiKey', required: false }));
    expect(withoutKey.fields[0]).toEqual(expect.objectContaining({ name: 'apiKey', required: true }));
  });

  it('defaults the pin slot field to the current slot', () => {
    const form = buildConfigureBotForm({ hasApiKey: true, currentSlot: 2, storedModel: null, hasThinkingLevel: false });
    expect(form.fields[1]).toEqual(expect.objectContaining({ name: 'pinSlot', defaultValue: ['2'] }));
  });

  it('nests the model select and thinking-level toggle under an Advanced group', () => {
    const form = buildConfigureBotForm({ hasApiKey: true, currentSlot: 1, storedModel: null, hasThinkingLevel: false });
    const group = form.fields[2] as { type: string; label: string; fields: { name: string }[] };
    expect(group).toEqual(expect.objectContaining({ type: 'group', label: 'Advanced (optional)' }));
    expect(group.fields.map(f => f.name)).toEqual(['geminiModel', 'customizeThinking']);
  });
});

describe('buildThinkingLevelForm', () => {
  it('names the model in the description and offers that model\'s level field', () => {
    const form = buildThinkingLevelForm({ model: 'gemini-pro-latest', thinkingLevel: undefined });
    expect(form.description).toContain('gemini-pro-latest');
    expect(form.fields).toHaveLength(1);
    expect(form.fields[0]).toEqual(expect.objectContaining({ name: 'thinkingLevel' }));
  });
});

const defaultPrevious: GeminiChoice = { model: DEFAULT_GEMINI_MODEL, isDefaultModel: true, thinkingLevel: undefined };

describe('decideConfigureBotSubmission', () => {
  it('keeps the saved API key when the field is left blank', () => {
    const decision = decideConfigureBotSubmission({ apiKey: '  ', pinSlot: ['1'] }, defaultPrevious);
    expect(decision.apiKeyToSet).toBeNull();
  });

  it('trims and saves a newly entered API key', () => {
    const decision = decideConfigureBotSubmission({ apiKey: '  AIzaSyTest  ', pinSlot: ['1'] }, defaultPrevious);
    expect(decision.apiKeyToSet).toBe('AIzaSyTest');
  });

  it('defaults an unrecognized or missing pin slot choice to "1"', () => {
    expect(decideConfigureBotSubmission({}, defaultPrevious).slot).toBe('1');
    expect(decideConfigureBotSubmission({ pinSlot: ['3'] }, defaultPrevious).slot).toBe('1');
  });

  it('accepts pin slot "2"', () => {
    expect(decideConfigureBotSubmission({ pinSlot: ['2'] }, defaultPrevious).slot).toBe('2');
  });

  it('clears the stored model override when "Recommended" is chosen', () => {
    const decision = decideConfigureBotSubmission({ pinSlot: ['1'], geminiModel: [DEFAULT_CHOICE] }, defaultPrevious);
    expect(decision.storedModel).toBeNull();
    expect(decision.model).toBe(DEFAULT_GEMINI_MODEL);
  });

  it('stores a specific picked model', () => {
    const decision = decideConfigureBotSubmission({ pinSlot: ['1'], geminiModel: ['gemini-pro-latest'] }, defaultPrevious);
    expect(decision.storedModel).toBe('gemini-pro-latest');
    expect(decision.model).toBe('gemini-pro-latest');
  });

  it('opens the thinking-level step and keeps the override when the model is unchanged', () => {
    const previous: GeminiChoice = { model: 'gemini-pro-latest', isDefaultModel: false, thinkingLevel: 'high' };
    const decision = decideConfigureBotSubmission(
      { pinSlot: ['1'], geminiModel: ['gemini-pro-latest'], customizeThinking: true },
      previous
    );
    expect(decision.openThinkingForm).toBe(true);
    expect(decision.clearThinkingLevel).toBe(false);
    expect(decision.thinkingFormDefault).toBe('high');
  });

  it('opens the thinking-level step but clears the prior override when the model changed', () => {
    const previous: GeminiChoice = { model: 'gemini-flash-latest', isDefaultModel: false, thinkingLevel: 'high' };
    const decision = decideConfigureBotSubmission(
      { pinSlot: ['1'], geminiModel: ['gemini-pro-latest'], customizeThinking: true },
      previous
    );
    expect(decision.openThinkingForm).toBe(true);
    expect(decision.clearThinkingLevel).toBe(true);
    expect(decision.thinkingFormDefault).toBeUndefined();
  });

  it('clears the override and skips the second step when the toggle is off', () => {
    const previous: GeminiChoice = { model: 'gemini-pro-latest', isDefaultModel: false, thinkingLevel: 'high' };
    const decision = decideConfigureBotSubmission(
      { pinSlot: ['1'], geminiModel: ['gemini-pro-latest'], customizeThinking: false },
      previous
    );
    expect(decision.openThinkingForm).toBe(false);
    expect(decision.clearThinkingLevel).toBe(true);
  });

  it('ignores the toggle for a model with no catalog thinking levels', () => {
    const decision = decideConfigureBotSubmission(
      { pinSlot: ['1'], geminiModel: ['gemini-retired-model'], customizeThinking: true },
      defaultPrevious
    );
    expect(decision.openThinkingForm).toBe(false);
  });

  it('includes the API key in the toast only when one was saved', () => {
    const withoutKey = decideConfigureBotSubmission({ pinSlot: ['1'] }, defaultPrevious);
    const withKey = decideConfigureBotSubmission({ apiKey: 'AIzaSyTest', pinSlot: ['1'] }, defaultPrevious);
    expect(withoutKey.toast).not.toContain('API key saved');
    expect(withKey.toast).toContain('API key saved');
  });
});

describe('decideThinkingLevelSubmission', () => {
  it('resolves a chosen level the model accepts', () => {
    const decision = decideThinkingLevelSubmission('gemini-pro-latest', ['medium']);
    expect(decision.level).toBe('medium');
    expect(decision.toast).toBe('gemini-pro-latest will use medium thinking.');
  });

  it('falls back to the model deciding when "Model default" is chosen', () => {
    const decision = decideThinkingLevelSubmission('gemini-pro-latest', [DEFAULT_CHOICE]);
    expect(decision.level).toBeUndefined();
    expect(decision.toast).toBe('gemini-pro-latest will decide how much to think.');
  });

  it('falls back to the model deciding when the chosen level is not accepted', () => {
    const decision = decideThinkingLevelSubmission('gemini-pro-latest', ['none']);
    expect(decision.level).toBeUndefined();
  });
});

describe('configureBotDraftKey', () => {
  it('scopes the draft key to the user', () => {
    expect(configureBotDraftKey('t2_abc123')).toBe('configure_bot_draft:t2_abc123');
  });

  it('still produces a stable key when the user id is missing', () => {
    expect(configureBotDraftKey(undefined)).toBe('configure_bot_draft:unknown');
  });
});

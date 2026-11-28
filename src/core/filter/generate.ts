import { getArchetype } from '../archetypes/index.ts';
import type { Archetype } from '../archetypes/types.ts';
import { PRESET_VERSION } from '../../meta/index.ts';
import { resolveSelection } from '../../meta/resolve.ts';
import type { BuildSelection } from '../../meta/types.ts';
import { baseTypeMeta } from '../data/base-types.ts';
import { prepareCustomRules, type SkippedRule } from '../rules/sanitize.ts';
import { emitFilterWithSpans } from './emit.ts';
import { buildHashParams } from './hash.ts';
import { junkRules } from './junk.ts';
import {
  getPreset,
  STRICTNESS_LABELS_PUBLIC,
  type Phase,
  type Preset,
  type Strictness,
} from './presets.ts';
import { baseTypesFor, gearRules } from './rules/gear.ts';
import { currencyRules } from './rules/currency.ts';
import { gemRules } from './rules/gems.ts';
import { mapRules } from './rules/maps.ts';
import { leagueRules } from './rules/league.ts';
import { uniqueRules } from './rules/uniques.ts';
import { COLORS, type FilterAction, type Rule, type RuleSection } from './types.ts';
import { applyTheme, type ThemeId } from './themes.ts';
import { filterNameFor, validateFilter, type FilterIssue } from './validate.ts';
import { buildFileName } from './name.ts';
import { DEFAULT_FILTER_VERSION, FILTER_FORMAT_VERSION } from './version.ts';

export interface Sections {
  gear: boolean;
  gems: boolean;
  currency: boolean;
  maps: boolean;
  uniques: boolean;
}

export const DEFAULT_SECTIONS: Sections = {
  gear: true,
  gems: true,
  currency: true,
  maps: true,
  uniques: true,
};

export const SECTION_KEYS = Object.keys(DEFAULT_SECTIONS) as (keyof Sections)[];

export interface FilterConfig {
  /** Legacy 12-build selector; kept for old links and goldens. */
  archetypeId?: string;
  /** New family/ascendancy/meta selection. Takes precedence. */
  selection?: BuildSelection;
  phase: Phase;
  strictness: Strictness;
  sections?: Sections;
  /** Visual theme applied after rule generation. */
  theme?: ThemeId;
  /** User rules, evaluated before the generated preset. */
  customRules?: Rule[];
  /** Build version embedded in the header and file name. */
  version?: string;
  /** Optional user name for the downloaded file. */
  buildName?: string;
}

export interface CompiledFilter {
  archetype: Archetype;
  preset: Preset;
  sections: Sections;
  version: string;
  theme: ThemeId;
  rules: Rule[];
  baseTypes: string[];
  /** Custom rules left out of the filter, by position in `customRules`. */
  skippedCustomRules: SkippedRule[];
}

export interface GeneratedFilter extends CompiledFilter {
  text: string;
  fileName: string;
  ruleCount: number;
  baseTypeCount: number;
  warnings: FilterIssue[];
  /** 1-based line range of each enabled rule in `text`, for provenance. */
  lineSpans: RuleLineSpan[];
}

export interface RuleLineSpan {
  index: number;
  id?: string;
  section?: RuleSection;
  comment?: string;
  action: FilterAction;
  startLine: number;
  endLine: number;
}

export function normalizeSections(sections?: Partial<Sections>): Sections {
  return { ...DEFAULT_SECTIONS, ...sections };
}

/** Quest items are always shown and audible, even in From Scratch hide-all. */
const QUEST_RULE: Rule = {
  action: 'Show',
  id: 'quest-items',
  section: 'quest',
  comment: 'Quest items',
  classNames: ['Quest Items'],
  styleKind: 'quest',
  style: {
    textColor: COLORS.white,
    borderColor: COLORS.gold,
    backgroundColor: COLORS.black,
    fontSize: 40,
    alertSound: 1,
    alertVolume: 300,
    minimapIcon: { size: 1, color: 'Green', shape: 'Circle' },
  },
};

/**
 * Labyrinth treasure keys are quest-like pickups: always shown and audible,
 * whatever the build or strictness. RePoE does not ship the base, so
 * "Treasure Key" is a reviewed entry in base-types-extra.json.
 */
const TREASURE_KEY_RULE: Rule = {
  action: 'Show',
  id: 'quest-treasure-key',
  section: 'quest',
  comment: 'Labyrinth treasure key',
  baseTypes: ['Treasure Key'],
  styleKind: 'quest',
  style: {
    textColor: COLORS.white,
    borderColor: COLORS.gold,
    backgroundColor: COLORS.black,
    fontSize: 40,
    alertSound: 1,
    alertVolume: 300,
    minimapIcon: { size: 1, color: 'Green', shape: 'Circle' },
  },
};

/**
 * Veiled items carry an unidentified mod worth unveiling, so they are always
 * shown whatever the build or strictness. The game matches a mod name that
 * contains "Veil", covering "Veiled" and legacy names such as "of the Veil".
 */
const VEILED_RULE: Rule = {
  action: 'Show',
  id: 'veiled-items',
  section: 'veiled',
  comment: 'Veiled items',
  hasExplicitMod: ['Veil'],
  styleKind: 'veiled',
  style: {
    fontSize: 45,
  },
};

const MANA_FLASK = 'Mana Flask';

/**
 * While leveling, a fresh character drinks mana flasks as much as life flasks,
 * so they get the same slot treatment. Endgame profiles never use them.
 */
function withLevelingFlasks(archetype: Archetype, phase: Phase): Archetype {
  if (phase !== 'leveling') return archetype;
  const flask = archetype.slots.flask;
  if (!flask || flask.itemClasses.includes(MANA_FLASK)) return archetype;
  return {
    ...archetype,
    slots: {
      ...archetype.slots,
      flask: { ...flask, itemClasses: [...flask.itemClasses, MANA_FLASK] },
    },
  };
}

/**
 * Builds the rule list without serialising it. The preview matcher consumes
 * the same rules the filter is generated from, so they cannot drift.
 */
export function compileFilter(config: FilterConfig): CompiledFilter {
  const resolved = config.selection
    ? resolveSelection(config.selection)
    : getArchetype(config.archetypeId ?? '');
  if (!resolved) {
    throw new Error(
      config.archetypeId
        ? `Unknown archetype "${config.archetypeId}"`
        : 'Provide either a selection or an archetypeId',
    );
  }
  const archetype = withLevelingFlasks(resolved, config.phase);

  const preset = getPreset(config.phase, config.strictness);
  const sections = normalizeSections(config.sections);
  const version = config.version ?? DEFAULT_FILTER_VERSION;
  const theme = config.theme ?? 'rarity';

  // A custom rule may predate a data fix and list a base the game dropped. Drop
  // those names here so the emitted filter always loads, whatever the source.
  // A rule left with an empty list is skipped and reported, never widened.
  const enabled = (config.customRules ?? [])
    .map((rule, index) => ({ rule, index }))
    .filter(({ rule }) => !rule.disabled);
  const prepared = prepareCustomRules(enabled.map(({ rule }) => rule));
  const skippedCustomRules = prepared.skipped.map((entry) => ({
    ...entry,
    index: enabled[entry.index]!.index,
  }));
  const customRules = prepared.rules.map((rule, index) => ({
    ...rule,
    id: rule.id ?? `custom-${index}`,
    section: rule.section ?? ('custom' as RuleSection),
  }));

  if (config.selection?.mode === 'scratch') {
    const start = config.selection.scratchStart === 'show' ? 'show' : 'hide';
    const baseRule: Rule = {
      action: start === 'show' ? 'Show' : 'Hide',
      id: 'scratch-base',
      section: 'custom',
      comment: `From scratch - ${start} everything`,
      itemLevel: { min: 0 },
    };
    const bases = new Set(customRules.flatMap((rule) => rule.baseTypes ?? []));
    return {
      archetype,
      preset,
      sections,
      version,
      theme,
      rules: applyTheme(
        [QUEST_RULE, TREASURE_KEY_RULE, VEILED_RULE, ...customRules, baseRule],
        theme,
      ),
      baseTypes: [...bases].sort(),
      skippedCustomRules,
    };
  }

  const rules: Rule[] = [
    QUEST_RULE,
    TREASURE_KEY_RULE,
    VEILED_RULE,
    ...customRules,
  ];
  const baseTypes = new Set<string>();

  for (const spec of Object.values(archetype.slots)) {
    if (!spec) continue;
    for (const base of baseTypesFor(spec)) baseTypes.add(base);
  }
  for (const rule of customRules) {
    for (const base of rule.baseTypes ?? []) baseTypes.add(base);
  }

  const add = (section: RuleSection, generated: Rule[]) => {
    for (const rule of generated) {
      rules.push({
        ...rule,
        id: `${section}-${rules.length}`,
        section,
      });
    }
  };

  if (sections.gear) {
    add('gear', gearRules(archetype, preset, config.phase, config.strictness));
  }
  if (sections.gems) add('gems', gemRules(preset));
  if (sections.currency) add('currency', currencyRules(preset));
  if (sections.maps) add('maps', mapRules(preset, config.phase));
  if (sections.uniques) add('uniques', uniqueRules(preset));

  add('junk', junkRules(archetype, preset));
  // Style-only category rules run last so they never change what the preset
  // shows; they only restyle items that were already visible.
  add('league', leagueRules());

  return {
    archetype,
    preset,
    sections,
    version,
    theme,
    rules: applyTheme(rules, theme),
    baseTypes: [...baseTypes].sort(),
    skippedCustomRules,
  };
}

export function generateFilter(config: FilterConfig): GeneratedFilter {
  const compiled = compileFilter(config);

  const scratch = config.selection?.mode === 'scratch';
  const scratchStart =
    config.selection?.scratchStart === 'show' ? 'show' : 'hide';

  const header = [
    '========================================================================',
    `BuildPath ${compiled.version} - filter format ${FILTER_FORMAT_VERSION}`,
    'Build-specific loot filter',
    `Build: ${compiled.archetype.name}${
      compiled.archetype.class
        ? ` - ${compiled.archetype.class}${
            compiled.archetype.ascendancy
              ? ` / ${compiled.archetype.ascendancy}`
              : ''
          }`
        : ''
    }`,
    ...(scratch
      ? [`Mode: From scratch - ${scratchStart} everything`]
      : [
          `Phase: ${config.phase === 'leveling' ? 'Leveling' : 'Endgame'} - ${STRICTNESS_LABELS_PUBLIC[config.strictness]}`,
        ]),
    ...(config.phase === 'leveling' && !scratch
      ? [
          'Leveling stages: area 1-9 all, 10-19 4-socket whites, 20-67 4-links/RGB, 68+ crafting bases',
        ]
      : []),
    // Lets the folder lister load a BuildPath file back into the builder.
    ...(config.selection
      ? [
          `Selection: ${buildHashParams({
            selection: config.selection,
            phase: config.phase,
            strictness: config.strictness,
            theme: compiled.theme,
            name: config.buildName,
          })}`,
        ]
      : []),
    `League: ${compiled.archetype.verifiedFor}`,
    `Presets: ${PRESET_VERSION}`,
    `Rules: ${compiled.rules.length} - Base types: ${compiled.baseTypes.length}`,
    `Base data: RePoE ${baseTypeMeta.ref} (${baseTypeMeta.sha256.slice(0, 8)})`,
    'Generated at https://lordgreg.github.io/buildpath/',
    'Not affiliated with or endorsed by Grinding Gear Games.',
    '========================================================================',
  ];

  const { text, spans, rejected } = emitFilterWithSpans(header, compiled.rules);

  return {
    ...compiled,
    text,
    fileName: config.selection
      ? buildFileName({
          selection: config.selection,
          phase: config.phase,
          strictness: config.strictness,
          name: config.buildName,
        })
      : filterNameFor(
          `buildpath-${compiled.archetype.id}-${config.phase}-${config.strictness}`,
        ),
    ruleCount: compiled.rules.length,
    baseTypeCount: compiled.baseTypes.length,
    warnings: [
      ...rejected.map((entry) => ({
        message: `Rule "${entry.rule.comment ?? entry.rule.id ?? entry.index + 1}" was left out: ${entry.reason}.`,
      })),
      ...validateFilter(text),
    ],
    lineSpans: spans.map((span) => ({
      index: span.index,
      id: span.rule.id,
      section: span.rule.section,
      comment: span.rule.comment,
      action: span.rule.action,
      startLine: span.startLine,
      endLine: span.endLine,
    })),
  };
}
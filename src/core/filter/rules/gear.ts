import type { Archetype, ItemSlot, SlotSpec } from '../../archetypes/types.ts';
import { resolveSlotBases } from '../../data/resolve.ts';
import { toFilterClass } from '../classes.ts';
import type { GearStage, Phase, Preset, Strictness } from '../presets.ts';
import { SLOT_STYLES, type Rule, type Style, type StyleKind } from '../types.ts';

const WEAPON_SLOTS = new Set<ItemSlot>(['weapon', 'offhand']);
const ARMOUR_SLOTS = new Set<ItemSlot>(['helmet', 'body', 'gloves', 'boots']);
const ACCESSORY_SLOTS = new Set<ItemSlot>([
  'belt',
  'amulet',
  'ring',
  'jewel',
  'flask',
]);
const SOCKET_SLOTS = new Set<ItemSlot>([
  'weapon',
  'offhand',
  'helmet',
  'body',
  'gloves',
  'boots',
]);

/** Accessories and jewels stay worth identifying below the gear cutoff. */
const ACCESSORY_ITEM_LEVEL = 68;

/** Cluster jewels are never part of a slot spec; they are always worth a look. */
const CLUSTER_JEWELS = [
  'Large Cluster Jewel',
  'Medium Cluster Jewel',
  'Small Cluster Jewel',
];

/**
 * Abyss jewels roll one affix pool per damage style. The build's family picks
 * the eye that fits; a family without a match keeps the generic jewel behaviour.
 */
const ABYSS_JEWELS: Record<string, string> = {
  caster: 'Hypnotic Eye Jewel',
  minion: 'Ghastly Eye Jewel',
  melee: 'Murderous Eye Jewel',
  bow: 'Searching Eye Jewel',
  hybrid: 'Searching Eye Jewel',
};

/** Every family eye, so soft can show the ones the build does not use. */
const ABYSS_EYE_BASES = [...new Set(Object.values(ABYSS_JEWELS))].sort();

/** Quiet jewel styling: visible and labelled, without an alert. */
const JEWEL_COVERAGE_STYLE: Style = {
  textColor: SLOT_STYLES.accessory.textColor,
  borderColor: SLOT_STYLES.accessory.borderColor,
  fontSize: 38,
  minimapIcon: { size: 1, color: 'Green', shape: 'Hexagon' },
};

/** Jewels every build should see, whatever its slot targeting. */
export function jewelCoverageRules(
  archetype: Archetype,
  strictness: Strictness,
): Rule[] {
  const rules: Rule[] = [
    {
      action: 'Show',
      comment: 'Cluster jewels',
      baseTypes: CLUSTER_JEWELS,
      styleKind: 'jewel',
      style: JEWEL_COVERAGE_STYLE,
    },
  ];

  const abyss = archetype.familyId ? ABYSS_JEWELS[archetype.familyId] : undefined;
  if (abyss) {
    rules.push({
      action: 'Show',
      comment: `Abyss jewels - ${archetype.familyId}`,
      baseTypes: [abyss],
      styleKind: 'jewel',
      style: JEWEL_COVERAGE_STYLE,
    });

    // Soft keeps every family eye visible; Strict and Uber keep only the
    // build's own eye. The build eye stays first so it can be styled apart.
    if (strictness === 'soft') {
      const others = ABYSS_EYE_BASES.filter((base) => base !== abyss);
      if (others.length > 0) {
        rules.push({
          action: 'Show',
          comment: 'Abyss jewels - all families',
          baseTypes: others,
          styleKind: 'jewel',
          style: JEWEL_COVERAGE_STYLE,
        });
      }
    }
  }

  return rules;
}

export function slotStyle(slot: ItemSlot): Style {
  if (WEAPON_SLOTS.has(slot)) return SLOT_STYLES.weapon;
  if (ARMOUR_SLOTS.has(slot)) return SLOT_STYLES.armour;
  return SLOT_STYLES.accessory;
}

function categoryFor(slot: ItemSlot): StyleKind | undefined {
  if (slot === 'jewel') return 'jewel';
  if (slot === 'flask') return 'flask';
  return undefined;
}

function quiet(style: Style): Style {
  return {
    textColor: style.textColor,
    borderColor: style.borderColor,
    fontSize: 34,
  };
}

export function filterClassesFor(spec: SlotSpec): string[] {
  return spec.itemClasses.map(toFilterClass);
}

/** Base types when the spec is narrow enough; otherwise an empty list. */
export function baseTypesFor(spec: SlotSpec): string[] {
  if (spec.bases?.length) return [...new Set(spec.bases)].sort();
  if (spec.tags?.length) {
    return [...new Set(resolveSlotBases(spec).map((base) => base.name))].sort();
  }
  return [];
}

export function usedFilterClasses(archetype: Archetype): Set<string> {
  const classes = new Set<string>();
  for (const spec of Object.values(archetype.slots)) {
    if (!spec) continue;
    for (const className of filterClassesFor(spec)) classes.add(className);
  }
  return classes;
}

/** `area 1-9`, `area 68+`; used in rule comments so the pane explains itself. */
function areaLabel(area: { min: number; max?: number }): string {
  return area.max === undefined
    ? `area ${area.min}+`
    : `area ${area.min}-${area.max}`;
}

interface AreaBand {
  areaLevel?: { min: number; max?: number };
  value: number | null;
}

/**
 * Consecutive stages with the same gate collapse into one band, so two areas
 * that behave alike cost one block rather than two. The last stage is open
 * ended, so merging it removes the upper bound.
 */
function mergeBands(
  stages: readonly GearStage[],
  pick: (stage: GearStage) => number | null,
): AreaBand[] {
  const bands: AreaBand[] = [];
  for (const stage of stages) {
    const value = pick(stage);
    const last = bands.at(-1);
    if (last && last.value === value && last.areaLevel) {
      last.areaLevel = {
        min: last.areaLevel.min,
        ...(stage.areaLevel.max !== undefined
          ? { max: stage.areaLevel.max }
          : {}),
      };
      continue;
    }
    bands.push({ areaLevel: { ...stage.areaLevel }, value });
  }
  return bands;
}

function slotTarget(spec: SlotSpec): Pick<Rule, 'baseTypes' | 'classNames'> {
  const bases = baseTypesFor(spec);
  return bases.length > 0
    ? { baseTypes: bases }
    : { classNames: filterClassesFor(spec) };
}

export function gearRules(
  archetype: Archetype,
  preset: Preset,
  phase: Phase,
  strictness: Strictness,
): Rule[] {
  const rules: Rule[] = [...jewelCoverageRules(archetype, strictness)];
  const isLeveling = phase === 'leveling' && preset.gearStages.length > 0;
  const stages = isLeveling ? preset.gearStages : [];

  const magicBands: AreaBand[] = isLeveling
    ? mergeBands(stages, (stage) => stage.magicMinItemLevel)
    : [{ value: preset.gear.magicMinItemLevel }];
  const normalBands: AreaBand[] = isLeveling
    ? mergeBands(stages, (stage) => stage.normalMinItemLevel)
    : [{ value: preset.gear.normalMinItemLevel }];

  const socketStages = stages.filter(
    (stage) => stage.normalMinSockets !== undefined,
  );
  const socketArea = socketStages.length
    ? {
        min: socketStages[0]!.areaLevel.min,
        ...(socketStages.at(-1)!.areaLevel.max !== undefined
          ? { max: socketStages.at(-1)!.areaLevel.max! }
          : {}),
      }
    : null;
  const socketCount = socketStages[0]?.normalMinSockets;

  const areaOf = (band: AreaBand) =>
    isLeveling && band.areaLevel ? { areaLevel: band.areaLevel } : {};
  const suffixOf = (band: AreaBand) =>
    isLeveling && band.areaLevel ? ` (${areaLabel(band.areaLevel)})` : '';

  const excludedBases = new Set([
    ...(preset.gear.hiddenBases ?? []),
    ...(archetype.excludedBases ?? []),
  ]);
  for (const base of excludedBases) {
    for (const rarity of ['Normal', 'Magic', 'Rare'] as const) {
      rules.push({
        action: 'Hide',
        comment: `${base} (${rarity.toLowerCase()}) - excluded base`,
        baseTypes: [base],
        rarity,
      });
    }
  }

  // A caster base can still be worth a rare identification (life and resists
  // do not care about the implicit), so hide only the normal and magic drops.
  const excludedMagicBases = new Set(archetype.excludedMagicBases ?? []);
  for (const base of excludedMagicBases) {
    for (const rarity of ['Normal', 'Magic'] as const) {
      rules.push({
        action: 'Hide',
        comment: `${base} (${rarity.toLowerCase()}) - excluded base, rare kept`,
        baseTypes: [base],
        rarity,
      });
    }
  }

  const slots = Object.entries(archetype.slots) as [ItemSlot, SlotSpec][];

  // Rare floors do not change by area, so they need no band.
  for (const [slot, spec] of slots) {
    const rareMinItemLevel = ACCESSORY_SLOTS.has(slot)
      ? Math.min(preset.gear.rareMinItemLevel, ACCESSORY_ITEM_LEVEL)
      : preset.gear.rareMinItemLevel;

    rules.push({
      action: 'Show',
      comment: `${slot} - rare`,
      ...slotTarget(spec),
      rarity: 'Rare',
      itemLevel: { min: rareMinItemLevel },
      ...(categoryFor(slot) ? { styleKind: categoryFor(slot) } : {}),
      style: slotStyle(slot),
    });
  }

  for (const band of magicBands) {
    if (band.value === null && !isLeveling) continue;
    for (const [slot, spec] of slots) {
      const floor = band.value === null ? 0 : band.value;
      // With the magic link gate on, only gear that is never a link target
      // (rings, amulets, belts, jewels, flasks) keeps a floor of its own.
      if (band.value === null && !ACCESSORY_SLOTS.has(slot)) continue;
      rules.push({
        action: 'Show',
        comment: `${slot} - magic${suffixOf(band)}`,
        ...slotTarget(spec),
        ...areaOf(band),
        rarity: 'Magic',
        itemLevel: { min: floor },
        ...(categoryFor(slot) ? { styleKind: categoryFor(slot) } : {}),
        style: quiet(slotStyle(slot)),
      });
    }
  }

  if (preset.gear.highlightLinks) {
    // Links matter more than the item level floor, so every rarity the build
    // can craft on keeps its highlight; uniques are handled apart.
    for (const [slot, spec] of slots) {
      if (!SOCKET_SLOTS.has(slot)) continue;
      for (const rarity of ['Normal', 'Magic', 'Rare'] as const) {
        rules.push({
          action: 'Show',
          comment: `${slot} - ${rarity.toLowerCase()} 4+ links`,
          ...slotTarget(spec),
          rarity,
          linkedSockets: { min: 4 },
          style: SLOT_STYLES.link,
        });
      }
    }
  }

  if (isLeveling) {
    for (const [slot, spec] of slots) {
      if (!SOCKET_SLOTS.has(slot)) continue;
      // A linked R-G-B group is a chromatic orb; worth a look all game.
      rules.push({
        action: 'Show',
        comment: `${slot} - magic RGB links`,
        ...slotTarget(spec),
        rarity: 'Magic',
        socketGroup: 'RGB',
        style: SLOT_STYLES.link,
      });
    }
  }

  // White flasks are the only flasks a new character owns; keep them through
  // the early acts, then let the junk rules hide them.
  if (isLeveling && archetype.slots.flask) {
    rules.push({
      action: 'Show',
      comment: 'flask - normal (area 1-29)',
      ...slotTarget(archetype.slots.flask),
      areaLevel: { min: 1, max: 29 },
      rarity: 'Normal',
      styleKind: 'flask',
      style: quiet(slotStyle('flask')),
    });
  }

  for (const rarity of ['Normal', 'Magic', 'Rare'] as const) {
    rules.push({
      action: 'Show',
      comment: `Six sockets - ${rarity.toLowerCase()}`,
      rarity,
      sockets: { min: 6 },
      style: SLOT_STYLES.link,
    });
  }

  // Four-socket whites run after the six-socket rules so a six-socket keeps
  // the louder link highlight, and before the white floors so a 4-socket item
  // below the crafting band still shows.
  if (isLeveling && socketArea && socketCount !== undefined) {
    for (const [slot, spec] of slots) {
      if (!SOCKET_SLOTS.has(slot)) continue;
      rules.push({
        action: 'Show',
        comment: `${slot} - normal ${socketCount}+ sockets (${areaLabel(socketArea)})`,
        ...slotTarget(spec),
        areaLevel: socketArea,
        rarity: 'Normal',
        sockets: { min: socketCount },
        ...(categoryFor(slot) ? { styleKind: categoryFor(slot) } : {}),
        style: quiet(slotStyle(slot)),
      });
    }
  }

  // White base floors run after the 6-socket rules so a six-socket still wins
  // the link highlight, and skip flasks: a normal flask is never a crafting
  // base, so the junk rules hide it.
  for (const band of normalBands) {
    if (band.value === null) continue;
    for (const [slot, spec] of slots) {
      if (slot === 'flask') continue;
      rules.push({
        action: 'Show',
        comment: `${slot} - normal${suffixOf(band)}`,
        ...slotTarget(spec),
        ...areaOf(band),
        rarity: 'Normal',
        itemLevel: { min: band.value },
        ...(categoryFor(slot) ? { styleKind: categoryFor(slot) } : {}),
        style: quiet(slotStyle(slot)),
      });
    }
  }

  return rules;
}
import {
  deepFreeze,
  exactObject,
  integer,
  portableId,
  sha256Value,
  uniqueList
} from './schema.mjs';

const CONTRACT_FIELDS = [
  'schemaVersion',
  'background',
  'connectivity',
  'minimumComponentPixels',
  'maxDecodedRgbaBytes',
  'padding',
  'expectedCandidates',
  'allowUnassigned',
  'groups'
];

function boolean(value, label) {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`);
  return value;
}

function rgba(value, label) {
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    value.some((channel) => !Number.isSafeInteger(channel) || channel < 0 || channel > 255)
  ) {
    throw new Error(`${label} must be an RGBA array with four byte channels`);
  }
  return value;
}

function validateBackground(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('pose-board background must be an object');
  }
  const fields = value.mode === 'color'
    ? ['mode', 'rgba', 'tolerance']
    : ['mode', 'tolerance'];
  if (Object.hasOwn(value, 'spill')) fields.push('spill');
  if (value.mode === 'color') {
    exactObject(value, fields, 'pose-board background');
    rgba(value.rgba, 'pose-board background RGBA');
  } else if (value.mode === 'border') {
    exactObject(value, fields, 'pose-board background');
  } else {
    throw new Error('pose-board background mode must be color or border');
  }
  integer(value.tolerance, 'pose-board background tolerance', { min: 0, max: 255 });
  if (Object.hasOwn(value, 'spill')) {
    exactObject(value.spill, ['minimumDominance'], 'pose-board chroma spill');
    integer(
      value.spill.minimumDominance,
      'pose-board chroma spill minimumDominance',
      { min: 1, max: 255 }
    );
  }
}

function validateExpectedCandidates(value) {
  exactObject(value, ['min', 'max'], 'pose-board expectedCandidates');
  integer(value.min, 'pose-board minimum candidate count', { min: 1, max: 4096 });
  integer(value.max, 'pose-board maximum candidate count', { min: 1, max: 4096 });
  if (value.min > value.max) throw new Error('pose-board candidate count range is invalid');
}

function validateGroups(groups) {
  if (!Array.isArray(groups)) throw new Error('pose-board groups must be a list');
  const groupIds = new Set();
  const componentMembership = new Set();

  for (const [index, group] of groups.entries()) {
    exactObject(group, ['id', 'componentIds'], `pose-board group ${index}`);
    portableId(group.id, `pose-board group ${index} ID`);
    if (groupIds.has(group.id)) throw new Error('pose-board group IDs must be unique');
    groupIds.add(group.id);

    uniqueList(group.componentIds, `pose-board group ${group.id} component IDs`);
    for (const componentId of group.componentIds) {
      portableId(componentId, `pose-board group ${group.id} component ID`);
      if (!/^component-\d{4}$/.test(componentId)) {
        throw new Error(`pose-board group ${group.id} component ID is invalid`);
      }
      if (componentMembership.has(componentId)) {
        throw new Error('pose-board group component membership must be unique');
      }
      componentMembership.add(componentId);
    }
  }
}

export function validatePoseBoardContract(value) {
  const document = structuredClone(value);
  exactObject(document, CONTRACT_FIELDS, 'pose-board recovery contract');
  integer(document.schemaVersion, 'pose-board recovery contract schemaVersion', { min: 1, max: 1 });
  validateBackground(document.background);
  integer(document.connectivity, 'pose-board connectivity', { min: 4, max: 4 });
  integer(document.minimumComponentPixels, 'pose-board minimumComponentPixels', {
    min: 1,
    max: 268435456
  });
  integer(document.maxDecodedRgbaBytes, 'pose-board maxDecodedRgbaBytes', {
    min: 4,
    max: 1073741824
  });
  integer(document.padding, 'pose-board padding', { min: 0, max: 256 });
  validateExpectedCandidates(document.expectedCandidates);
  boolean(document.allowUnassigned, 'pose-board allowUnassigned');
  validateGroups(document.groups);
  sha256Value(document);
  return deepFreeze(document);
}

export function poseBoardContractHash(value) {
  return sha256Value(validatePoseBoardContract(value));
}

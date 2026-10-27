import type { DiagramKind } from '../../shared/protocol';
import { timeFamily } from './time';
import { dataFamily } from './data';
import { architectureFamily } from './architecture';

export const nativeFamilies = [timeFamily, dataFamily, architectureFamily];
export const familyFor = (kind: DiagramKind) => nativeFamilies.find(family => family.kinds.includes(kind));

import { customAlphabet } from 'nanoid';

const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
const nano = customAlphabet(alphabet, 20);

/** Generate a prefixed, sortable-enough, URL-safe id, e.g. `itm_x4k2...`. */
export function newId(prefix: string): string {
  return `${prefix}_${nano()}`;
}

export const IdPrefix = {
  user: 'usr',
  workspace: 'wsp',
  sourceAccount: 'acc',
  sourceItem: 'itm',
  sourceAttachment: 'att',
  person: 'per',
  organization: 'org',
  project: 'prj',
  taskCandidate: 'tsk',
  digest: 'dig',
  digestItem: 'dgi',
  userPreference: 'prf',
  memoryEntry: 'mem',
  permissionPolicy: 'pol',
  approvalRequest: 'apr',
  auditLog: 'aud',
  conversation: 'cnv',
  message: 'msg',
  uploadedFile: 'upl',
  connectorRun: 'run',
  llmProviderConfig: 'llm',
  llmTaskRoute: 'rte',
  llmCallLog: 'llg',
  retrievalChunk: 'chk',
  embeddingRecord: 'emb',
  agentAction: 'act',
  itemFeedback: 'fbk',
  appSetting: 'set',
  learningSignal: 'sig',
  learnedPreference: 'lpr',
  idempotencyKey: 'idk',
  dataDeletionRequest: 'del',
} as const;

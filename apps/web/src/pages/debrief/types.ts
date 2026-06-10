import type { Digest, DigestItem } from '@donna/core';

/** Shape returned by GET /api/digests/latest, /api/digests/:id and POST /api/digests/generate. */
export type DigestWithItems = Digest & { items: DigestItem[] };

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { renderMarkdownWithHeadingIds } from '@orbit/services/markdown';
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import type { WorkspaceData } from '@/features/issues/workspace-provider.tsx';
import * as workspaceProvider from '@/features/issues/workspace-provider.tsx';
import { createQueryClient } from '@/lib/query/provider.tsx';
import { restoreModulesAfterThisFile } from '../../../tests-support.ts';

await restoreModulesAfterThisFile(['@/features/issues/workspace-provider.tsx']);

mock.module('@orbit/realtime-client/react', () => ({
  useScopeSubscription: () => undefined,
  useDeltaHandler: () => undefined,
}));

mock.module('next/navigation', () => ({
  useRouter: () => ({ push: mock(), replace: mock(), refresh: mock() }),
  usePathname: () => '/docs/doc_1',
  useParams: () => ({ id: 'doc_1' }),
}));

mock.module('@/components/ui/toast.tsx', () => ({
  useToast: () => ({ toast: () => undefined }),
}));

const workspace = {
  ready: true,
  userId: 'user_writer',
  teams: [],
  states: [],
  labels: [],
  members: [],
  projects: [],
  cycles: [],
  seedIssues: [],
  stateById: new Map(),
  labelById: new Map(),
  memberById: new Map(),
  openQuickCreate: () => undefined,
} as unknown as WorkspaceData;

mock.module('@/features/issues/workspace-provider.tsx', () => ({
  ...workspaceProvider,
  useWorkspace: () => workspace,
}));

const { DocSurface } = await import('../../../src/features/docs/doc-surface.tsx');

const MARKDOWN = '# Delta protocol\n\nEvery mutation bumps sync_id.';
const SERVER_TITLE = 'Delta protocol';
const DRAFT_TITLE = 'Delta protocol v2';

interface RequestLog {
  readonly method: string;
  readonly url: string;
  readonly body: string | null;
}

let requests: RequestLog[] = [];
let patchesFail = true;
const realFetch = globalThis.fetch;

function docPayload(revision: number) {
  return {
    doc: {
      id: 'doc_1',
      organizationId: 'org_1',
      collectionId: null,
      projectId: null,
      parentId: null,
      title: SERVER_TITLE,
      slug: 'delta-protocol',
      content: MARKDOWN,
      revision,
      sortOrder: 0,
      visibility: 'private',
      publishToken: null,
      authorId: 'user_author',
      repoBinding: null,
      syncId: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      archivedAt: null,
    },
    contentHtml: renderMarkdownWithHeadingIds(MARKDOWN),
    attachments: [],
    author: { id: 'user_author', name: 'Ada', image: null },
    followers: 1,
    backlinks: [],
    access: 'write',
  };
}

function stubFetch(): void {
  globalThis.fetch = mock((input: string, init?: { method?: string; body?: string }) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    requests.push({ method, url, body: typeof init?.body === 'string' ? init.body : null });

    const answered = (payload: unknown, status = 200) => ({
      ok: status < 400,
      status,
      json: () => Promise.resolve(payload),
    });
    const body = (payload: unknown, status = 200) => Promise.resolve(answered(payload, status));

    if (url.startsWith('/api/docs/doc_1') && method === 'PATCH') {
      if (patchesFail) {
        return body(
          {
            error: {
              code: 'conflict',
              message: 'That doc changed since you opened it. Your draft was not saved.',
              details: { reason: 'stale_revision', revision: 4 },
            },
          },
          409,
        );
      }
      return body({
        doc: docPayload(4).doc,
        contentHtml: renderMarkdownWithHeadingIds(MARKDOWN),
      });
    }
    if (url.endsWith('/visit')) return body({ docId: 'doc_1' });
    if (url.startsWith('/api/docs/doc_1')) return body(docPayload(3));
    if (url.startsWith('/api/docs')) return body({ docs: [], collections: [], projects: [] });
    if (url.startsWith('/api/comments')) return body({ comments: [] });
    return body({});
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  requests = [];
  patchesFail = true;
  stubFetch();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function patchRequests(): RequestLog[] {
  return requests.filter((entry) => entry.method === 'PATCH');
}

async function renderSurface(): Promise<void> {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <TooltipProvider>
        <DocSurface docId="doc_1" canWriteDocs canPublish={false} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  await screen.findByTestId('doc-title-input');
}

async function typeDraftTitle(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const title = screen.getByTestId('doc-title-input');
  await user.clear(title);
  await user.type(title, DRAFT_TITLE);
}

describe('saving a doc someone else changed', () => {
  it('sends the revision the draft was built on and refuses a stale save without dropping the draft', async () => {
    const user = userEvent.setup();
    await renderSurface();

    await typeDraftTitle(user);

    await waitFor(() => expect(patchRequests()).toHaveLength(1), { timeout: 4000 });
    const sent = JSON.parse(patchRequests()[0]?.body ?? '{}');
    expect(sent.baseRevision).toBe(3);
    expect(sent.title).toBe(DRAFT_TITLE);

    expect(await screen.findByTestId('doc-save-conflict')).toBeInTheDocument();
    expect((screen.getByTestId('doc-title-input') as HTMLInputElement).value).toBe(DRAFT_TITLE);
  });

  it('loads their version on request and then saves cleanly from it', async () => {
    const user = userEvent.setup();
    await renderSurface();

    await typeDraftTitle(user);
    await screen.findByTestId('doc-save-conflict', {}, { timeout: 4000 });

    patchesFail = false;
    await user.click(screen.getByRole('button', { name: /load their version/i }));

    expect((screen.getByTestId('doc-title-input') as HTMLInputElement).value).toBe(SERVER_TITLE);
    expect(screen.queryByTestId('doc-save-conflict')).toBeNull();

    await waitFor(() => expect(patchRequests().length).toBeGreaterThan(1), { timeout: 4000 });
    expect(screen.queryByTestId('doc-save-conflict')).toBeNull();
  });
});

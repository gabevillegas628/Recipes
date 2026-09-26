import type { QueryClient } from '@tanstack/react-query';

/**
 * Drops back to the login screen. Sets ['me'] to null (rather than clearing the
 * cache) so App's existing subscription to it re-renders, then discards
 * everything else so the next user doesn't see stale data.
 */
export function signOut(queryClient: QueryClient) {
  queryClient.setQueryData(['me'], null);
  queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
}

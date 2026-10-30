import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/shared/api';
import type { Project,FileTreeNode } from '@/shared/types';

type UseFileTreeDataResult = {
  files: FileTreeNode[];
  loading: boolean;
  error: string | null;
  refreshFiles: () => void;
  loadDirectory: (path: string) => Promise<void>;
};

const DEFAULT_LOAD_ERROR = 'Unable to load the file tree for this project.';

// The API reports refusals such as FILE_TREE_TOO_LARGE as { error: message }.
// Surfacing that message tells the user why the tree is missing and what to do
// about it, instead of leaving them with an unexplained empty tree.
function readResponseErrorMessage(responseBody: string): string | null {
  try {
    const parsedBody = JSON.parse(responseBody) as unknown;
    const message = typeof parsedBody === 'object' && parsedBody !== null && 'error' in parsedBody
      ? (parsedBody as { error: unknown }).error
      : null;
    return typeof message === 'string' && message.trim() ? message : null;
  } catch {
    return null;
  }
}

export function useFileTreeData(selectedProject: Project | null): UseFileTreeDataResult {
  const [files, setFiles] = useState<FileTreeNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const pendingDirectories = useRef(new Set<string>());

  const refreshFiles = useCallback(() => {
    setRefreshKey((prev) => prev + 1);
  }, []);

  useEffect(() => {
    // File-tree requests use the DB projectId; the backend resolves it to the
    // project's absolute path through the projects table.
    const projectId = selectedProject?.projectId;

    if (!projectId) {
      setFiles([]);
      setLoading(false);
      setError(null);
      return;
    }

    // Abort previous request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    // Track mount state so aborted or late responses do not enqueue stale state updates.
    let isActive = true;

    const fetchFiles = async () => {
      if (isActive) {
        setLoading(true);
        setError(null);
      }
      try {
        const response = await api.getFileChildren(projectId, '', { signal: abortControllerRef.current!.signal });

        if (!response.ok) {
          const errorText = await response.text();
          console.error('File fetch failed:', response.status, errorText);
          if (isActive) {
            setFiles([]);
            setError(readResponseErrorMessage(errorText) ?? DEFAULT_LOAD_ERROR);
          }
          return;
        }

        const data = (await response.json()) as FileTreeNode[];
        if (isActive) {
          setFiles(data);
        }
      } catch (error) {
        if ((error as { name?: string }).name === 'AbortError') {
          return;
        }

        console.error('Error fetching files:', error);
        if (isActive) {
          setFiles([]);
          setError(DEFAULT_LOAD_ERROR);
        }
      } finally {
        if (isActive) {
          setLoading(false);
        }
      }
    };

    void fetchFiles();

    return () => {
      isActive = false;
      abortControllerRef.current?.abort();
    };
  }, [selectedProject?.projectId, refreshKey]);

  const loadDirectory = useCallback(async (directory: string) => {
    if (!selectedProject?.projectId) return;
    const controller = abortControllerRef.current;
    const key = selectedProject.projectId + '\0' + directory;
    if (pendingDirectories.current.has(key)) return;
    pendingDirectories.current.add(key);
    try {
      const response = await api.getFileChildren(selectedProject.projectId, directory, {signal:controller?.signal});
      if (!response.ok) throw Error(readResponseErrorMessage(await response.text()) || DEFAULT_LOAD_ERROR);
      const children = await response.json() as FileTreeNode[];
      if (controller?.signal.aborted) return;
      const merge = (nodes: FileTreeNode[]): FileTreeNode[] => nodes.map(node => node.path === directory ? {...node,children} : node.children ? {...node,children:merge(node.children)} : node);
      setFiles(nodes => merge(nodes));
    } catch (cause) { if (!controller?.signal.aborted) setError(cause instanceof Error ? cause.message : DEFAULT_LOAD_ERROR); }
    finally { pendingDirectories.current.delete(key); }
  }, [selectedProject?.projectId]);

  return {
    loadDirectory,
    files,
    loading,
    error,
    refreshFiles,
  };
}

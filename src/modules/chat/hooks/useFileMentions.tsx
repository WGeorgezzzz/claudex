import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, KeyboardEvent, RefObject, SetStateAction } from 'react';

import { api } from '@/shared/api';
import { escapeRegExp } from '@/modules/chat/utils/chatFormatting';
import type { Project } from '@/shared/types';

export type MentionableFile = {
  name: string;
  path: string;
  relativePath?: string;
};

type UseFileMentionsOptions = {
  selectedProject: Project | null;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  textareaRef: RefObject<HTMLTextAreaElement>;
};

// True when both flattened lists hold the same files in the same order.
const haveSameFiles = (left: MentionableFile[], right: MentionableFile[]) =>
  left.length === right.length &&
  left.every(
    (file, index) => file.path === right[index].path && file.relativePath === right[index].relativePath,
  );

export function useFileMentions({ selectedProject, input, setInput, textareaRef }: UseFileMentionsOptions) {
  const projectId = selectedProject?.projectId;
  const [fileList, setFileList] = useState<MentionableFile[]>([]);
  const [fileMentions, setFileMentions] = useState<string[]>([]);
  const [filteredFiles, setFilteredFiles] = useState<MentionableFile[]>([]);
  const [showFileDropdown, setShowFileDropdown] = useState(false);
  const [selectedFileIndex, setSelectedFileIndex] = useState(-1);
  const [cursorPosition, setCursorPosition] = useState(0);
  const [atSymbolPosition, setAtSymbolPosition] = useState(-1);
  // The file-list request still in flight. Starting a new one aborts it, so an
  // older response can never overwrite a newer list.
  const fileListRequestRef = useRef<AbortController | null>(null);

  const loadProjectFiles = useCallback(async (targetProjectId: string, query: string) => {
    fileListRequestRef.current?.abort();
    const abortController = new AbortController();
    fileListRequestRef.current = abortController;

    try {
      // File list is keyed by DB projectId now; the backend resolves it to
      // the project's path before reading.
      const response = await api.searchFiles(targetProjectId, query, {
        signal: abortController.signal,
      }, selectedProject?.fullPath||selectedProject?.path);
      if (!response.ok) {
        return;
      }

      const result = await response.json();
      if (abortController.signal.aborted) {
        return;
      }
      const root = (selectedProject?.fullPath || selectedProject?.path || '').replace(/\\/g,'/').replace(/\/$/,'');
      const nextFileList: MentionableFile[] = result.files.map((file: {name:string;path:string}) => ({name:file.name,path:file.path.replace(/\\/g,'/').replace(root+'/',''),relativePath:file.path}));
      // Keeping the same array when nothing changed stops the filter effect
      // below from re-running and resetting the highlighted row.
      setFileList((previousFileList) =>
        haveSameFiles(previousFileList, nextFileList) ? previousFileList : nextFileList,
      );
    } catch (error) {
      // Ignore aborts from newer requests and rapid project switches; we only care about the latest request.
      if ((error as { name?: string })?.name === 'AbortError') {
        return;
      }
      console.error('Error fetching files:', error);
    }
  }, [selectedProject?.fullPath,selectedProject?.path]);

  const mentionQuery = input.slice(0,cursorPosition).split('@').at(-1) || '';
  useEffect(() => {
    if (!showFileDropdown || !projectId) return;
    setFileList([]); setFilteredFiles([]);
    const timer = setTimeout(() => {void loadProjectFiles(projectId,mentionQuery);},150);
    return () => {clearTimeout(timer);fileListRequestRef.current?.abort();};
  },[showFileDropdown,projectId,mentionQuery,loadProjectFiles]);

  useEffect(() => {
    const textBeforeCursor = input.slice(0, cursorPosition);
    const lastAtIndex = textBeforeCursor.lastIndexOf('@');

    if (lastAtIndex === -1) {
      setShowFileDropdown(false);
      setAtSymbolPosition(-1);
      return;
    }

    const textAfterAt = textBeforeCursor.slice(lastAtIndex + 1);
    if (textAfterAt.includes(' ')) {
      setShowFileDropdown(false);
      setAtSymbolPosition(-1);
      return;
    }

    setAtSymbolPosition(lastAtIndex);
    setShowFileDropdown(true);
    setSelectedFileIndex(-1);

    const matchingFiles = fileList
      .filter(
        (file) =>
          file.name.toLowerCase().includes(textAfterAt.toLowerCase()) ||
          file.path.toLowerCase().includes(textAfterAt.toLowerCase()),
      )
      .slice(0, 10);

    setFilteredFiles(matchingFiles);
  }, [input, cursorPosition, fileList]);

  const activeFileMentions = useMemo(() => {
    if (!input || fileMentions.length === 0) {
      return [];
    }
    return fileMentions.filter((path) => input.includes(path));
  }, [fileMentions, input]);

  const sortedFileMentions = useMemo(() => {
    if (activeFileMentions.length === 0) {
      return [];
    }
    const uniqueMentions = Array.from(new Set(activeFileMentions));
    return uniqueMentions.sort((mentionA, mentionB) => mentionB.length - mentionA.length);
  }, [activeFileMentions]);

  const fileMentionRegex = useMemo(() => {
    if (sortedFileMentions.length === 0) {
      return null;
    }
    const pattern = sortedFileMentions.map(escapeRegExp).join('|');
    return new RegExp(`(${pattern})`, 'g');
  }, [sortedFileMentions]);

  const fileMentionSet = useMemo(() => new Set(sortedFileMentions), [sortedFileMentions]);

  const renderInputWithMentions = useCallback(
    (text: string) => {
      if (!text) {
        return '';
      }
      if (!fileMentionRegex) {
        return text;
      }

      const parts = text.split(fileMentionRegex);
      return parts.map((part, index) =>
        fileMentionSet.has(part) ? (
          <span
            key={`mention-${index}`}
            className="-ml-0.5 rounded-md bg-blue-200/70 box-decoration-clone px-0.5 text-transparent dark:bg-blue-300/40"
          >
            {part}
          </span>
        ) : (
          <span key={`text-${index}`}>{part}</span>
        ),
      );
    },
    [fileMentionRegex, fileMentionSet],
  );

  const selectFile = useCallback(
    (file: MentionableFile) => {
      const textBeforeAt = input.slice(0, atSymbolPosition);
      const textAfterAtQuery = input.slice(atSymbolPosition);
      const spaceIndex = textAfterAtQuery.indexOf(' ');
      const textAfterQuery = spaceIndex !== -1 ? textAfterAtQuery.slice(spaceIndex) : '';

      const mention=/\s/.test(file.path)?'@\"'+file.path+'\"':'@'+file.path;
      const newInput = `${textBeforeAt}${mention} ${textAfterQuery}`;
      const newCursorPosition = textBeforeAt.length + mention.length + 1;

      if (textareaRef.current && !textareaRef.current.matches(':focus')) {
        textareaRef.current.focus();
      }

      setInput(newInput);
      setCursorPosition(newCursorPosition);
      setFileMentions((previousMentions) =>
        previousMentions.includes(mention) ? previousMentions : [...previousMentions, mention],
      );

      setShowFileDropdown(false);
      setAtSymbolPosition(-1);

      if (!textareaRef.current) {
        return;
      }

      requestAnimationFrame(() => {
        if (!textareaRef.current) {
          return;
        }
        textareaRef.current.setSelectionRange(newCursorPosition, newCursorPosition);
        if (!textareaRef.current.matches(':focus')) {
          textareaRef.current.focus();
        }
      });
    },
    [input, atSymbolPosition, textareaRef, setInput],
  );

  const handleFileMentionsKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!showFileDropdown) {
        return false;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        // The caret is still inside the `@` query, so a refetch landing after
        // this would re-open the dropdown (or first show it, when nothing
        // matched yet) and take the next Enter. Drop it; re-opening the
        // dropdown fetches again.
        fileListRequestRef.current?.abort();
        setShowFileDropdown(false);
        return true;
      }

      if (filteredFiles.length === 0) {
        return false;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelectedFileIndex((previousIndex) =>
          previousIndex < filteredFiles.length - 1 ? previousIndex + 1 : 0,
        );
        return true;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelectedFileIndex((previousIndex) =>
          previousIndex > 0 ? previousIndex - 1 : filteredFiles.length - 1,
        );
        return true;
      }

      if (event.key === 'Tab' || event.key === 'Enter') {
        event.preventDefault();
        if (selectedFileIndex >= 0) {
          selectFile(filteredFiles[selectedFileIndex]);
        } else if (filteredFiles.length > 0) {
          selectFile(filteredFiles[0]);
        }
        return true;
      }

      return false;
    },
    [showFileDropdown, filteredFiles, selectedFileIndex, selectFile],
  );

  const fileNames=useMemo(()=>fileList.map(file=>file.path),[fileList]);
  return {
    fileNames,
    showFileDropdown,
    filteredFiles,
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    setCursorPosition,
    handleFileMentionsKeyDown,
  };
}

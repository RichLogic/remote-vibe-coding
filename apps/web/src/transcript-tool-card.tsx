import type { SessionFileChange, SessionTranscriptEntry } from './types';

type Language = 'en' | 'zh';
type DiffLineKind = 'meta' | 'hunk' | 'add' | 'remove' | 'context';
type FileChangeTone = 'add' | 'remove' | 'update';

interface TranscriptToolCardProps {
  entry: SessionTranscriptEntry;
  badgeLabel: string;
  language: Language;
  noInlineDiffLabel: string;
  onSelectFileChange?: ((change: SessionFileChange) => void) | undefined;
}

interface DiffLine {
  kind: DiffLineKind;
  oldLineNumber: number | null;
  newLineNumber: number | null;
  text: string;
}

const HUNK_HEADER_PATTERN = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function changeKindLabel(kind: string, language: Language) {
  switch (kind.toLowerCase()) {
    case 'create':
      return language === 'zh' ? '新增' : 'Created';
    case 'delete':
      return language === 'zh' ? '删除' : 'Deleted';
    case 'rename':
      return language === 'zh' ? '重命名' : 'Renamed';
    default:
      return language === 'zh' ? '修改' : 'Updated';
  }
}

function changeTone(kind: string): FileChangeTone {
  switch (kind.toLowerCase()) {
    case 'create':
      return 'add';
    case 'delete':
      return 'remove';
    default:
      return 'update';
  }
}

function parseUnifiedDiff(diff: string): DiffLine[] {
  const rawLines = diff.split('\n');
  if (rawLines[rawLines.length - 1] === '') {
    rawLines.pop();
  }

  const lines: DiffLine[] = [];
  let oldLineNumber = 0;
  let newLineNumber = 0;
  let hasActiveHunk = false;

  for (const line of rawLines) {
    const hunkMatch = line.match(HUNK_HEADER_PATTERN);
    if (hunkMatch) {
      oldLineNumber = Number.parseInt(hunkMatch[1] ?? '0', 10);
      newLineNumber = Number.parseInt(hunkMatch[2] ?? '0', 10);
      hasActiveHunk = true;
      lines.push({
        kind: 'hunk',
        oldLineNumber: null,
        newLineNumber: null,
        text: line,
      });
      continue;
    }

    if (
      line.startsWith('diff --git')
      || line.startsWith('index ')
      || line.startsWith('--- ')
      || line.startsWith('+++ ')
      || line.startsWith('Binary files ')
      || line.startsWith('\\ No newline at end of file')
    ) {
      lines.push({
        kind: 'meta',
        oldLineNumber: null,
        newLineNumber: null,
        text: line,
      });
      continue;
    }

    if (!hasActiveHunk) {
      lines.push({
        kind: 'meta',
        oldLineNumber: null,
        newLineNumber: null,
        text: line,
      });
      continue;
    }

    if (line.startsWith('+')) {
      lines.push({
        kind: 'add',
        oldLineNumber: null,
        newLineNumber,
        text: line,
      });
      newLineNumber += 1;
      continue;
    }

    if (line.startsWith('-')) {
      lines.push({
        kind: 'remove',
        oldLineNumber,
        newLineNumber: null,
        text: line,
      });
      oldLineNumber += 1;
      continue;
    }

    lines.push({
      kind: 'context',
      oldLineNumber,
      newLineNumber,
      text: line,
    });
    oldLineNumber += 1;
    newLineNumber += 1;
  }

  return lines;
}

function formatLineNumber(value: number | null) {
  return value === null ? '' : String(value);
}

function hasStructuredFileChanges(entry: SessionTranscriptEntry): entry is SessionTranscriptEntry & { fileChanges: SessionFileChange[] } {
  return Array.isArray(entry.fileChanges) && entry.fileChanges.length > 0;
}

function renderFileChange(
  change: SessionFileChange,
  index: number,
  language: Language,
  noInlineDiffLabel: string,
  onSelectFileChange?: (change: SessionFileChange) => void,
) {
  const tone = changeTone(change.kind);
  const diffLines = change.diff ? parseUnifiedDiff(change.diff) : [];

  return (
    <section key={`${change.path}-${index}`} className={`timeline-diff-file timeline-diff-file-${tone}`}>
      <header className="timeline-diff-file-header">
        {onSelectFileChange ? (
          <button
            type="button"
            className="timeline-diff-path-button"
            onClick={() => onSelectFileChange(change)}
            title={change.path}
          >
            <code className="timeline-diff-path">{change.path}</code>
          </button>
        ) : (
          <code className="timeline-diff-path" title={change.path}>{change.path}</code>
        )}
        <span className={`timeline-diff-kind timeline-diff-kind-${tone}`}>{changeKindLabel(change.kind, language)}</span>
      </header>

      {diffLines.length > 0 ? (
        <div className="timeline-diff-lines">
          {diffLines.map((line, lineIndex) => (
            <div key={lineIndex} className={`timeline-diff-line timeline-diff-line-${line.kind}`}>
              <span className="timeline-diff-gutter">{formatLineNumber(line.oldLineNumber)}</span>
              <span className="timeline-diff-gutter">{formatLineNumber(line.newLineNumber)}</span>
              <code className="timeline-diff-text">{line.text || ' '}</code>
            </div>
          ))}
        </div>
      ) : (
        <p className="timeline-diff-empty">{noInlineDiffLabel}</p>
      )}
    </section>
  );
}

interface FileChangeListProps {
  fileChanges: SessionFileChange[];
  language: Language;
  noInlineDiffLabel: string;
  onSelectFileChange?: ((change: SessionFileChange) => void) | undefined;
}

export function FileChangeList({ fileChanges, language, noInlineDiffLabel, onSelectFileChange }: FileChangeListProps) {
  return (
    <div className="timeline-tool-output timeline-tool-files">
      {fileChanges.map((change, index) => renderFileChange(change, index, language, noInlineDiffLabel, onSelectFileChange))}
    </div>
  );
}

export function TranscriptToolCard({ entry, badgeLabel, language, noInlineDiffLabel, onSelectFileChange }: TranscriptToolCardProps) {
  return (
    <details className="timeline-tool-card">
      <summary className="timeline-tool-summary">
        <div className="timeline-tool-copy">
          <span className="timeline-tool-badge">{badgeLabel}</span>
          <strong>{entry.title ?? badgeLabel}</strong>
        </div>
        {entry.meta ? <span className="timeline-tool-meta">{entry.meta}</span> : null}
      </summary>

      {entry.label === 'files' && hasStructuredFileChanges(entry) ? (
        <FileChangeList
          fileChanges={entry.fileChanges}
          language={language}
          noInlineDiffLabel={noInlineDiffLabel}
          onSelectFileChange={onSelectFileChange}
        />
      ) : entry.body ? (
        <pre className="event-body timeline-tool-output">{entry.body}</pre>
      ) : null}
    </details>
  );
}

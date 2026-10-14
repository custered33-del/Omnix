import { Image as ImageIcon, Film, Sparkle, Code2, FileText, Presentation, type LucideProps } from 'lucide-react';
import type { ToolKind } from '@omnix/core';

const ICONS: Record<ToolKind, (p: LucideProps) => React.ReactElement> = {
  image: (p) => <ImageIcon {...p} />,
  video: (p) => <Film {...p} />,
  animation: (p) => <Sparkle {...p} />,
  code: (p) => <Code2 {...p} />,
  document: (p) => <FileText {...p} />,
  slides: (p) => <Presentation {...p} />,
};

export const TOOL_COLORS: Record<ToolKind, string> = {
  image: '#2a78d6',
  video: '#eb6834',
  animation: '#d55181',
  code: '#1baf7a',
  document: '#6250d6',
  slides: '#c98500',
};

export function ToolIcon({ tool, ...props }: { tool: ToolKind } & LucideProps) {
  return ICONS[tool](props);
}

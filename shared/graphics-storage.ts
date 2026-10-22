/** On-demand read-only logical file sizes. No cleanup command is exposed. */
export type GraphicsStorageReport = {
  measuredAt: string;
  roots: { label: string; path: string; bytes: number; files: number; incomplete: boolean }[];
  categories: { id: string; label: string; bytes: number; files: number; note: string }[];
  totalBytes: number;
  skippedLinks: number;
  unreadable: number;
  autoDelete: false;
};

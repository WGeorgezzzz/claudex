/** Used by MessageModelLabel to preserve the exact model ID reported for a reply. */
export const formatAnsweringModelLabel = (model: string | undefined): string | null => model?.trim() || null;

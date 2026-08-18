/** Shared PDF parsing and IPC budgets. Keep these browser-safe for the job preload. */
export const PDF_MAX_SOURCE_BYTES = 128 * 1024 * 1024
/** Editing uses a lower cap because pdf-lib expands objects in memory. Larger PDFs remain viewable. */
export const PDF_MAX_EDIT_SOURCE_BYTES = 64 * 1024 * 1024
export const PDF_MAX_JOB_INPUT_BYTES = 96 * 1024 * 1024
export const PDF_MAX_JOB_REQUEST_BYTES = 24 * 1024 * 1024
export const PDF_MAX_JOB_OUTPUT_BYTES = 96 * 1024 * 1024
/** Cross-platform renderer working-set kill threshold, reported by Electron in KiB. */
export const PDF_JOB_MAX_WORKING_SET_KIB = 768 * 1024
/** Keep each streamed transform chunk small and require backpressure between chunks. */
export const PDF_JOB_CHUNK_BYTES = 1024 * 1024
export const PDF_MAX_INDIRECT_OBJECTS = 250_000
export const PDF_EDIT_MAX_PAGES = 20_000

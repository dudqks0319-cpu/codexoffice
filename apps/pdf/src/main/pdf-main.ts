import { createHash, randomUUID } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { chmod, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { BrowserWindow, WebContentsView, app, dialog, ipcMain, shell } from 'electron'
import type { WebContents } from 'electron'
import {
  contextMenuLabels,
  installContextMenu,
  installNavigationGuard,
  safeExternalUrl,
} from '@genoffice/electron-utils'
import { createI18n, getUiLang } from '@genoffice/i18n'
import { PDF_CHANNELS } from '../shared/ipc'
import type {
  ExportImagesRequest,
  ExportImagesResult,
  ExtractPagesRequest,
  ExtractPagesResult,
  InsertPdfRequest,
  InsertPdfResult,
  SavePdfRequest,
  SavePdfResult,
  WritePdfRecoveryResult,
} from '../shared/ipc'
import { PDF_MAX_EDIT_SOURCE_BYTES } from '../shared/limits'
import { atomicWrite } from './atomic-write'
import { repairInterruptedPdfCommitSync, replacePdfIfUnchanged } from './conditional-write'
import {
  capturePdfDiskState,
  pdfSourceChanged,
  readPdfWithState,
  type PdfDiskState,
} from './pdf-file-state'
import { savePdfWithSourceGuard } from './guarded-save'
import { cancelPdfJobs, configurePdfJobPreload, runPdfJob } from './pdf-job-client'
import { prunePrivateArtifacts } from './private-artifacts'
import {
  clearPdfRecovery,
  inspectPdfRecovery,
  restorePdfRecovery,
  writePdfRecovery,
  type PdfRecoveryCandidate,
} from './pdf-recovery'
import {
  parseExportImagesRequest,
  parseExtractPagesRequest,
  parseInsertPdfRequest,
  parseSavePdfRequest,
} from './save-validation'

export { repairInterruptedPdfCommitSync } from './conditional-write'

const tDlg = createI18n({
  zh: {
    dlgExportImages: '导出图片到文件夹',
    dlgExtract: '抽取页面为 PDF',
    dlgInsert: '选择要插入的 PDF',
    filterPdf: 'PDF 文档',
    closeUnsavedMsg: '此 PDF 有未保存的更改。',
    closeUnsavedDetail: '关闭前是否保存？',
    btnSave: '保存',
    btnDontSave: '不保存',
    btnCancel: '取消',
  },
  en: {
    dlgExportImages: 'Export Images to Folder',
    dlgExtract: 'Extract Pages as PDF',
    dlgInsert: 'Choose a PDF to Insert',
    filterPdf: 'PDF Documents',
    closeUnsavedMsg: 'This PDF has unsaved changes.',
    closeUnsavedDetail: 'Do you want to save them before closing?',
    btnSave: 'Save',
    btnDontSave: "Don't Save",
    btnCancel: 'Cancel',
  },
  ja: {
    dlgExportImages: '画像をフォルダに書き出す',
    dlgExtract: 'ページを PDF として抽出',
    dlgInsert: '挿入する PDF を選択',
    filterPdf: 'PDF ドキュメント',
    closeUnsavedMsg: 'この PDF に未保存の変更があります。',
    closeUnsavedDetail: '閉じる前に保存しますか？',
    btnSave: '保存',
    btnDontSave: '保存しない',
    btnCancel: 'キャンセル',
  },
  ko: {
    dlgExportImages: '이미지를 폴더로 내보내기',
    dlgExtract: '페이지를 PDF로 추출',
    dlgInsert: '삽입할 PDF 선택',
    filterPdf: 'PDF 문서',
    closeUnsavedMsg: '이 PDF에 저장하지 않은 변경 사항이 있습니다.',
    closeUnsavedDetail: '닫기 전에 저장하시겠습니까?',
    btnSave: '저장',
    btnDontSave: '저장 안 함',
    btnCancel: '취소',
  },
  fr: {
    dlgExportImages: 'Exporter les images vers un dossier',
    dlgExtract: 'Extraire les pages en PDF',
    dlgInsert: 'Choisir un PDF à insérer',
    filterPdf: 'Documents PDF',
    closeUnsavedMsg: 'Ce PDF contient des modifications non enregistrées.',
    closeUnsavedDetail: 'Voulez-vous les enregistrer avant de fermer ?',
    btnSave: 'Enregistrer',
    btnDontSave: 'Ne pas enregistrer',
    btnCancel: 'Annuler',
  },
  de: {
    dlgExportImages: 'Bilder in Ordner exportieren',
    dlgExtract: 'Seiten als PDF extrahieren',
    dlgInsert: 'Einzufügendes PDF wählen',
    filterPdf: 'PDF-Dokumente',
    closeUnsavedMsg: 'Dieses PDF enthält ungespeicherte Änderungen.',
    closeUnsavedDetail: 'Vor dem Schließen speichern?',
    btnSave: 'Speichern',
    btnDontSave: 'Nicht speichern',
    btnCancel: 'Abbrechen',
  },
  es: {
    dlgExportImages: 'Exportar imágenes a una carpeta',
    dlgExtract: 'Extraer páginas como PDF',
    dlgInsert: 'Elegir un PDF para insertar',
    filterPdf: 'Documentos PDF',
    closeUnsavedMsg: 'Este PDF tiene cambios sin guardar.',
    closeUnsavedDetail: '¿Quieres guardarlos antes de cerrar?',
    btnSave: 'Guardar',
    btnDontSave: 'No guardar',
    btnCancel: 'Cancelar',
  },
  th: {
    dlgExportImages: 'ส่งออกรูปภาพไปยังโฟลเดอร์',
    dlgExtract: 'แยกหน้าเป็น PDF',
    dlgInsert: 'เลือก PDF ที่จะแทรก',
    filterPdf: 'เอกสาร PDF',
    closeUnsavedMsg: 'PDF นี้มีการเปลี่ยนแปลงที่ยังไม่ได้บันทึก',
    closeUnsavedDetail: 'ต้องการบันทึกก่อนปิดหรือไม่?',
    btnSave: 'บันทึก',
    btnDontSave: 'ไม่บันทึก',
    btnCancel: 'ยกเลิก',
  },
  id: {
    dlgExportImages: 'Ekspor gambar ke folder',
    dlgExtract: 'Ekstrak halaman sebagai PDF',
    dlgInsert: 'Pilih PDF untuk disisipkan',
    filterPdf: 'Dokumen PDF',
    closeUnsavedMsg: 'PDF ini memiliki perubahan yang belum disimpan.',
    closeUnsavedDetail: 'Simpan sebelum menutup?',
    btnSave: 'Simpan',
    btnDontSave: 'Jangan Simpan',
    btnCancel: 'Batal',
  },
  ru: {
    dlgExportImages: 'Экспорт изображений в папку',
    dlgExtract: 'Извлечь страницы в PDF',
    dlgInsert: 'Выберите PDF для вставки',
    filterPdf: 'Документы PDF',
    closeUnsavedMsg: 'В этом PDF есть несохранённые изменения.',
    closeUnsavedDetail: 'Сохранить их перед закрытием?',
    btnSave: 'Сохранить',
    btnDontSave: 'Не сохранять',
    btnCancel: 'Отмена',
  },
  ar: {
    dlgExportImages: 'تصدير الصور إلى مجلد',
    dlgExtract: 'استخراج الصفحات كملف PDF',
    dlgInsert: 'اختر PDF للإدراج',
    filterPdf: 'مستندات PDF',
    closeUnsavedMsg: 'يحتوي هذا الـ PDF على تغييرات غير محفوظة.',
    closeUnsavedDetail: 'هل تريد حفظها قبل الإغلاق؟',
    btnSave: 'حفظ',
    btnDontSave: 'عدم الحفظ',
    btnCancel: 'إلغاء',
  },
  pt: {
    dlgExportImages: 'Exportar imagens para pasta',
    dlgExtract: 'Extrair páginas como PDF',
    dlgInsert: 'Escolher um PDF para inserir',
    filterPdf: 'Documentos PDF',
    closeUnsavedMsg: 'Este PDF tem alterações não salvas.',
    closeUnsavedDetail: 'Deseja salvá-las antes de fechar?',
    btnSave: 'Salvar',
    btnDontSave: 'Não Salvar',
    btnCancel: 'Cancelar',
  },
  it: {
    dlgExportImages: 'Esporta immagini in una cartella',
    dlgExtract: 'Estrai pagine come PDF',
    dlgInsert: 'Scegli un PDF da inserire',
    filterPdf: 'Documenti PDF',
    closeUnsavedMsg: 'Questo PDF contiene modifiche non salvate.',
    closeUnsavedDetail: 'Vuoi salvarle prima di chiudere?',
    btnSave: 'Salva',
    btnDontSave: 'Non salvare',
    btnCancel: 'Annulla',
  },
  pl: {
    dlgExportImages: 'Eksportuj obrazy do folderu',
    dlgExtract: 'Wyodrębnij strony jako PDF',
    dlgInsert: 'Wybierz PDF do wstawienia',
    filterPdf: 'Dokumenty PDF',
    closeUnsavedMsg: 'Ten PDF ma niezapisane zmiany.',
    closeUnsavedDetail: 'Czy zapisać je przed zamknięciem?',
    btnSave: 'Zapisz',
    btnDontSave: 'Nie zapisuj',
    btnCancel: 'Anuluj',
  },
  nl: {
    dlgExportImages: 'Afbeeldingen naar map exporteren',
    dlgExtract: "Pagina's extraheren als PDF",
    dlgInsert: 'Kies een PDF om in te voegen',
    filterPdf: 'PDF-documenten',
    closeUnsavedMsg: 'Deze PDF bevat niet-opgeslagen wijzigingen.',
    closeUnsavedDetail: 'Wilt u ze opslaan voordat u sluit?',
    btnSave: 'Opslaan',
    btnDontSave: 'Niet opslaan',
    btnCancel: 'Annuleren',
  },
  ms: {
    dlgExportImages: 'Eksport imej ke folder',
    dlgExtract: 'Ekstrak halaman sebagai PDF',
    dlgInsert: 'Pilih PDF untuk disisipkan',
    filterPdf: 'Dokumen PDF',
    closeUnsavedMsg: 'PDF ini mempunyai perubahan yang belum disimpan.',
    closeUnsavedDetail: 'Simpan sebelum menutup?',
    btnSave: 'Simpan',
    btnDontSave: 'Jangan Simpan',
    btnCancel: 'Batal',
  },
  he: {
    dlgExportImages: 'ייצוא תמונות לתיקייה',
    dlgExtract: 'חילוץ עמודים כ-PDF',
    dlgInsert: 'בחרו PDF להוספה',
    filterPdf: 'מסמכי PDF',
    closeUnsavedMsg: 'ב-PDF הזה יש שינויים שלא נשמרו.',
    closeUnsavedDetail: 'האם לשמור אותם לפני הסגירה?',
    btnSave: 'שמירה',
    btnDontSave: 'אל תשמור',
    btnCancel: 'ביטול',
  },
  hi: {
    dlgExportImages: 'चित्र फ़ोल्डर में निर्यात करें',
    dlgExtract: 'पृष्ठों को PDF के रूप में निकालें',
    dlgInsert: 'सम्मिलित करने के लिए PDF चुनें',
    filterPdf: 'PDF दस्तावेज़',
    closeUnsavedMsg: 'इस PDF में सहेजे नहीं गए परिवर्तन हैं।',
    closeUnsavedDetail: 'क्या बंद करने से पहले उन्हें सहेजना चाहते हैं?',
    btnSave: 'सहेजें',
    btnDontSave: 'न सहेजें',
    btnCancel: 'रद्द करें',
  },
  'zh-TW': {
    dlgExportImages: '匯出圖片到資料夾',
    dlgExtract: '擷取頁面為 PDF',
    dlgInsert: '選擇要插入的 PDF',
    filterPdf: 'PDF 文件',
    closeUnsavedMsg: '此 PDF 有未儲存的變更。',
    closeUnsavedDetail: '關閉前是否儲存？',
    btnSave: '儲存',
    btnDontSave: '不儲存',
    btnCancel: '取消',
  },
})
type DlgKey =
  | 'dlgExportImages'
  | 'dlgExtract'
  | 'dlgInsert'
  | 'filterPdf'
  | 'closeUnsavedMsg'
  | 'closeUnsavedDetail'
  | 'btnSave'
  | 'btnDontSave'
  | 'btnCancel'
const tm = (key: DlgKey) => tDlg(getUiLang(), key)

interface RuntimePaths {
  preloadPath: string
  jobPreloadPath: string
  rendererUrl?: string
  rendererFile?: string
}

let runtime: RuntimePaths = { preloadPath: '', jobPreloadPath: '' }

export function configurePdfRuntime(paths: RuntimePaths): void {
  runtime = paths
  configurePdfJobPreload(paths.jobPreloadPath)
}

/** Open paths queued at tab creation; the renderer consumes them after mount (avoids did-finish-load races) */
const pendingByWc = new Map<number, string>()
/** File paths granted to each view — readFile only allows these */
const allowedByWc = new Map<number, Set<string>>()
/** Unsaved-changes flags mirrored from the renderer; drives the save prompt before closing a tab/window */
const dirtyByWc = new Set<number>()
const closeSaveWaiters = new Map<number, (ok: boolean) => void>()
const saveAsWaiters = new Map<number, (ok: boolean) => void>()
/** Save As destination granted per view (main-process dialog pick); the save handler refuses any other non-source target */
const saveAsTargetByWc = new Map<number, string>()

interface PdfSourceSession {
  readonly sourcePath: string
  readonly snapshotPath: string
  readonly diskState: PdfDiskState
}

/** Exact bytes the renderer loaded, isolated from later external writes. */
const sourceSessionByWc = new Map<number, PdfSourceSession>()
const snapshotReservationByWc = new Map<number, number>()
const MAX_ACTIVE_PDF_SNAPSHOTS = 32
const MAX_ACTIVE_PDF_SNAPSHOT_BYTES = 512 * 1024 * 1024

const sessionInstanceId = `${process.pid}-${randomUUID()}`
const sessionSourceRoot = () => join(app.getPath('userData'), 'pdf-session-sources')
const sessionSourceDir = () => join(sessionSourceRoot(), sessionInstanceId)
const conflictRecoveryDir = () => join(app.getPath('userData'), 'pdf-conflict-recovery')
const crashRecoveryDir = () => join(app.getPath('userData'), 'pdf-autosave')
const pathKey = (filePath: string) =>
  createHash('sha256').update(filePath).digest('hex').slice(0, 20)
const snapshotPathFor = (wcId: number, filePath: string) =>
  join(sessionSourceDir(), `${wcId}-${pathKey(filePath)}.pdf`)
const conflictRecoveryPathFor = (filePath: string) => {
  const extension = extname(filePath)
  const stem = basename(filePath, extension)
    .replace(/[^A-Za-z0-9._ -]/g, '_')
    .slice(0, 80)
  return join(conflictRecoveryDir(), `${stem || 'document'}-${pathKey(filePath)}-recovery.pdf`)
}

async function pruneOrphanPdfSessions(): Promise<void> {
  const root = sessionSourceRoot()
  await mkdir(root, { recursive: true, mode: 0o700 })
  await chmod(root, 0o700)
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name !== sessionInstanceId) {
      await rm(join(root, entry.name), { recursive: true, force: true })
    }
  }
}

async function refreshSourceSession(
  wcId: number,
  sourcePath: string,
  provided?: { bytes: Buffer; state: PdfDiskState },
): Promise<PdfSourceSession> {
  const loaded = provided ?? (await readPdfWithState(sourcePath))
  const previousReservation = snapshotReservationByWc.get(wcId) ?? 0
  const reservedBytes =
    [...snapshotReservationByWc.entries()].reduce((total, [id, size]) => {
      return id === wcId ? total : total + size
    }, 0) + loaded.state.size
  const reservedFiles = snapshotReservationByWc.has(wcId)
    ? snapshotReservationByWc.size
    : snapshotReservationByWc.size + 1
  if (reservedFiles > MAX_ACTIVE_PDF_SNAPSHOTS || reservedBytes > MAX_ACTIVE_PDF_SNAPSHOT_BYTES) {
    throw new Error('pdf: active document snapshot budget exceeded')
  }
  snapshotReservationByWc.set(wcId, loaded.state.size)
  const snapshotPath = snapshotPathFor(wcId, sourcePath)
  try {
    await atomicWrite(snapshotPath, loaded.bytes, { private: true })
  } catch (error) {
    if (previousReservation > 0) snapshotReservationByWc.set(wcId, previousReservation)
    else snapshotReservationByWc.delete(wcId)
    throw error
  }
  const previous = sourceSessionByWc.get(wcId)
  if (previous && previous.snapshotPath !== snapshotPath)
    void rm(previous.snapshotPath, { force: true })
  const session = { sourcePath, snapshotPath, diskState: loaded.state }
  sourceSessionByWc.set(wcId, session)
  return session
}

const recoveryEpochByPath = new Map<string, number>()
const recoverySerialByPath = new Map<string, Promise<void>>()
const mutationSerialByPath = new Map<string, Promise<void>>()

const nextRecoveryEpoch = (sourcePath: string): number => {
  const next = (recoveryEpochByPath.get(sourcePath) ?? 0) + 1
  recoveryEpochByPath.set(sourcePath, next)
  return next
}

function runRecoverySerial<T>(sourcePath: string, task: () => Promise<T>): Promise<T> {
  const previous = recoverySerialByPath.get(sourcePath) ?? Promise.resolve()
  const run = previous.catch(() => undefined).then(task)
  const tail = run.then(
    () => undefined,
    () => undefined,
  )
  recoverySerialByPath.set(sourcePath, tail)
  void tail.finally(() => {
    if (recoverySerialByPath.get(sourcePath) === tail) recoverySerialByPath.delete(sourcePath)
  })
  return run
}

function runPdfMutationSerial<T>(sourcePath: string, task: () => Promise<T>): Promise<T> {
  const previous = mutationSerialByPath.get(sourcePath) ?? Promise.resolve()
  const run = previous.catch(() => undefined).then(task)
  const tail = run.then(
    () => undefined,
    () => undefined,
  )
  mutationSerialByPath.set(sourcePath, tail)
  void tail.finally(() => {
    if (mutationSerialByPath.get(sourcePath) === tail) mutationSerialByPath.delete(sourcePath)
  })
  return run
}

async function clearCrashRecovery(sourcePath: string): Promise<void> {
  nextRecoveryEpoch(sourcePath)
  await runRecoverySerial(sourcePath, () => clearPdfRecovery(crashRecoveryDir(), sourcePath))
}

const recoveryCopyText = () => {
  switch (getUiLang()) {
    case 'ko':
      return {
        found: '저장하지 못한 PDF 편집본을 찾았습니다.',
        foundDetail: '원본은 마지막 복구 이후 변경되지 않았습니다. 편집본을 복원하시겠습니까?',
        restore: '복원',
        notNow: '나중에',
        discard: '복구본 삭제',
        changed: '원본 PDF가 복구본 생성 후 변경되었습니다.',
        changedDetail: (path: string) =>
          `원본은 덮어쓰지 않았습니다. 별도 복구본을 확인하세요.\n${path}`,
        reveal: '복구본 보기',
        openOriginal: '원본 열기',
      }
    case 'ja':
      return {
        found: '保存されなかった PDF 編集内容が見つかりました。',
        foundDetail: '元の PDF は変更されていません。編集内容を復元しますか？',
        restore: '復元',
        notNow: '後で',
        discard: '復旧版を削除',
        changed: '復旧版の作成後に元の PDF が変更されました。',
        changedDetail: (path: string) =>
          `元のファイルは上書きされていません。別の復旧版を確認してください。\n${path}`,
        reveal: '復旧版を表示',
        openOriginal: '元の PDF を開く',
      }
    case 'zh':
    case 'zh-TW':
      return {
        found: '发现未保存的 PDF 编辑恢复副本。',
        foundDetail: '原始 PDF 尚未更改。是否恢复这些编辑？',
        restore: '恢复',
        notNow: '稍后',
        discard: '删除恢复副本',
        changed: '原始 PDF 在恢复副本创建后已更改。',
        changedDetail: (path: string) => `原始文件未被覆盖。请查看单独的恢复副本。\n${path}`,
        reveal: '显示恢复副本',
        openOriginal: '打开原始 PDF',
      }
    default:
      return {
        found: 'Unsaved PDF edits were found.',
        foundDetail: 'The original PDF is unchanged. Restore the recovered edits?',
        restore: 'Restore',
        notNow: 'Not Now',
        discard: 'Delete Recovery',
        changed: 'The original PDF changed after the recovery copy was created.',
        changedDetail: (path: string) =>
          `The original was not overwritten. Review the separate recovery copy.\n${path}`,
        reveal: 'Show Recovery',
        openOriginal: 'Open Original',
      }
  }
}

async function showChangedRecovery(candidate: PdfRecoveryCandidate): Promise<'keep' | 'discard'> {
  const text = recoveryCopyText()
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    message: text.changed,
    detail: text.changedDetail(candidate.recoveryPath),
    buttons: [text.reveal, text.openOriginal, text.discard],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  })
  if (response === 0) shell.showItemInFolder(candidate.recoveryPath)
  return response === 2 ? 'discard' : 'keep'
}

async function maybeRestoreCrashRecovery(
  sourcePath: string,
  loaded: { bytes: Buffer; state: PdfDiskState },
): Promise<{ bytes: Buffer; state: PdfDiskState }> {
  const inspection = await inspectPdfRecovery(crashRecoveryDir(), sourcePath, loaded.state)
  if (inspection.kind === 'none') return loaded
  if (inspection.kind === 'source-changed') {
    if ((await showChangedRecovery(inspection.candidate)) === 'discard') {
      await clearCrashRecovery(sourcePath).catch(() => undefined)
    }
    return loaded
  }

  const text = recoveryCopyText()
  const { response } = await dialog.showMessageBox({
    type: 'question',
    message: text.found,
    detail: text.foundDetail,
    buttons: [text.restore, text.notNow, text.discard],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  })
  if (response === 2) {
    await clearCrashRecovery(sourcePath).catch(() => undefined)
    return loaded
  }
  if (response !== 0) return loaded
  try {
    await runPdfMutationSerial(sourcePath, () =>
      restorePdfRecovery(sourcePath, inspection.candidate),
    )
  } catch {
    const latest = await readPdfWithState(sourcePath)
    if ((await showChangedRecovery(inspection.candidate)) === 'discard') {
      await clearCrashRecovery(sourcePath).catch(() => undefined)
    }
    return latest
  }
  await clearCrashRecovery(sourcePath).catch(() => undefined)
  return readPdfWithState(sourcePath)
}

async function sourceSession(wcId: number, sourcePath: string): Promise<PdfSourceSession> {
  const current = sourceSessionByWc.get(wcId)
  if (current?.sourcePath === sourcePath) return current
  const sourceIsAlreadyOpen = [...sourceSessionByWc].some(
    ([otherWcId, session]) => otherWcId !== wcId && session.sourcePath === sourcePath,
  )
  const disk = await readPdfWithState(sourcePath)
  const loaded = sourceIsAlreadyOpen ? disk : await maybeRestoreCrashRecovery(sourcePath, disk)
  return refreshSourceSession(wcId, sourcePath, loaded)
}

export function pdfIsDirty(webContentsId: number): boolean {
  return dirtyByWc.has(webContentsId)
}

/**
 * Close guard for the pdf renderer: true means proceed with closing.
 * Clean → true; dirty → Save / Don't Save / Cancel. On Save, ask the renderer to
 * write to disk and await the result; on failure or timeout stay open (renderer
 * has already shown the error).
 */
export async function requestPdfClose(
  contents: WebContents,
  parent?: BrowserWindow | null,
): Promise<boolean> {
  if (!dirtyByWc.has(contents.id) || contents.isDestroyed()) return true
  const options = {
    type: 'warning' as const,
    message: tm('closeUnsavedMsg'),
    detail: tm('closeUnsavedDetail'),
    buttons: [tm('btnSave'), tm('btnDontSave'), tm('btnCancel')],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  }
  const { response } =
    parent && !parent.isDestroyed()
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options)
  if (response === 2) return false
  if (response === 1) {
    const source = sourceSessionByWc.get(contents.id)
    if (source) await clearCrashRecovery(source.sourcePath).catch(() => undefined)
    return true
  }
  return await requestRendererSave(contents)
}

function requestRendererSave(contents: WebContents): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      closeSaveWaiters.delete(contents.id)
      resolve(false)
    }, 120_000)
    closeSaveWaiters.set(contents.id, (ok) => {
      clearTimeout(timer)
      resolve(ok)
    })
    contents.send(PDF_CHANNELS.closeSaveRequest)
  })
}

/** Menu Save: ask the renderer to write pending edits to disk; clean views resolve true immediately */
export function flushPdfSave(contents: WebContents): Promise<boolean> {
  if (contents.isDestroyed() || !dirtyByWc.has(contents.id)) return Promise.resolve(true)
  return requestRendererSave(contents)
}

/**
 * Marks the whole Save As flow (dialog included) for the renderer, which pauses
 * autosave meanwhile: opening the save dialog blurs the window, and a
 * blur-triggered autosave would write the pending edits into the original file.
 */
export function setPdfSaveAsInFlight(contents: WebContents, inFlight: boolean): void {
  if (!contents.isDestroyed()) contents.send(PDF_CHANNELS.saveAsFlow, inFlight)
}

/**
 * Menu Save As: grant targetPath to the view, then ask the renderer to apply its
 * pending edits onto the source bytes and write the result to targetPath only.
 * The original file is never written (non-destructive Save As).
 */
export function requestPdfSaveAs(contents: WebContents, targetPath: string): Promise<boolean> {
  if (contents.isDestroyed()) return Promise.resolve(false)
  const wcId = contents.id
  saveAsTargetByWc.set(wcId, targetPath)
  return new Promise<boolean>((resolve) => {
    const done = (ok: boolean) => {
      saveAsTargetByWc.delete(wcId)
      resolve(ok)
    }
    const timer = setTimeout(() => {
      saveAsWaiters.delete(wcId)
      done(false)
    }, 120_000)
    saveAsWaiters.set(wcId, (ok) => {
      clearTimeout(timer)
      done(ok)
    })
    contents.send(PDF_CHANNELS.saveAsRequest, targetPath)
  })
}

let ipcRegistered = false

function registerPdfIpc(): void {
  if (ipcRegistered) return
  ipcRegistered = true
  void pruneOrphanPdfSessions().catch(() => undefined)
  void prunePrivateArtifacts(conflictRecoveryDir(), {
    maxFiles: 32,
    maxBytes: 512 * 1024 * 1024,
    maxAgeMs: 30 * 24 * 60 * 60 * 1_000,
  }).catch(() => undefined)
  void prunePrivateArtifacts(crashRecoveryDir(), {
    maxFiles: 96,
    maxBytes: 512 * 1024 * 1024,
    maxAgeMs: 30 * 24 * 60 * 60 * 1_000,
  }).catch(() => undefined)
  app.once('will-quit', () => {
    void rm(sessionSourceDir(), { recursive: true, force: true })
  })

  ipcMain.handle(PDF_CHANNELS.consumePending, (e) => {
    const path = pendingByWc.get(e.sender.id) ?? null
    pendingByWc.delete(e.sender.id)
    return path
  })

  ipcMain.handle(PDF_CHANNELS.readFile, async (e, path: unknown) => {
    if (typeof path !== 'string' || !allowedByWc.get(e.sender.id)?.has(path)) {
      throw new Error('pdf: path not granted to this view')
    }
    const session = await sourceSession(e.sender.id, path)
    const buf = await readFile(session.snapshotPath)
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  })

  ipcMain.handle(PDF_CHANNELS.save, async (e, raw: unknown): Promise<SavePdfResult> => {
    let request: SavePdfRequest
    try {
      request = parseSavePdfRequest(raw)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    const path = request?.path
    if (typeof path !== 'string' || !allowedByWc.get(e.sender.id)?.has(path)) {
      return { ok: false, error: 'pdf: path not granted to this view' }
    }
    // Save As targets must have been granted by requestPdfSaveAs (main-process dialog pick)
    const target = typeof request.targetPath === 'string' ? request.targetPath : path
    if (target !== path && saveAsTargetByWc.get(e.sender.id) !== target) {
      return { ok: false, error: 'pdf: target path not granted to this view' }
    }
    try {
      const wcId = e.sender.id
      const session = await sourceSession(wcId, path)
      const transformed = await runPdfJob(wcId, () => ({
        kind: 'save',
        source: {
          path: session.snapshotPath,
          byteLength: session.diskState.size,
          sha256: session.diskState.sha256,
        },
        request,
      }))
      return await runPdfMutationSerial(target, async (): Promise<SavePdfResult> => {
        if (
          sourceSessionByWc.get(wcId) !== session ||
          !allowedByWc.get(wcId)?.has(path) ||
          (target !== path && saveAsTargetByWc.get(wcId) !== target)
        ) {
          throw new Error('pdf: save superseded')
        }
        const guarded = await savePdfWithSourceGuard({
          sourcePath: path,
          targetPath: target,
          recoveryPath: conflictRecoveryPathFor(path),
          diskState: session.diskState,
          editedBytes: transformed.bytes,
        })
        if (guarded.kind === 'source-changed') {
          await clearCrashRecovery(path).catch(() => undefined)
          const preserved = guarded.preservedPath
            ? ` A concurrently displaced source was preserved at ${guarded.preservedPath}.`
            : ''
          return {
            ok: false,
            code: 'source-changed',
            recoveryPath: guarded.recoveryPath,
            error: `The PDF changed in another app. The original was not overwritten. Your edited recovery copy is at ${guarded.recoveryPath}.${preserved}`,
          }
        }
        if (target === path) {
          await refreshSourceSession(wcId, path)
          await clearCrashRecovery(path).catch(() => undefined)
        }
        return { ok: true }
      })
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(
    PDF_CHANNELS.writeRecovery,
    async (e, raw: unknown): Promise<WritePdfRecoveryResult> => {
      let request: SavePdfRequest
      try {
        request = parseSavePdfRequest(raw)
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
      const path = request.path
      if (!allowedByWc.get(e.sender.id)?.has(path) || request.targetPath !== undefined) {
        return { ok: false, error: 'pdf: path not granted to this view' }
      }
      try {
        const wcId = e.sender.id
        const session = await sourceSession(wcId, path)
        const epoch = nextRecoveryEpoch(path)
        const transformed = await runPdfJob(wcId, () => ({
          kind: 'save',
          source: {
            path: session.snapshotPath,
            byteLength: session.diskState.size,
            sha256: session.diskState.sha256,
          },
          request,
        }))
        return await runRecoverySerial(path, async () => {
          if (
            recoveryEpochByPath.get(path) !== epoch ||
            sourceSessionByWc.get(wcId) !== session ||
            !allowedByWc.get(wcId)?.has(path)
          ) {
            return { ok: false, error: 'pdf: recovery superseded' }
          }
          await writePdfRecovery({
            recoveryRoot: crashRecoveryDir(),
            sourcePath: path,
            baseState: session.diskState,
            editedBytes: transformed.bytes,
          })
          if (
            recoveryEpochByPath.get(path) !== epoch ||
            sourceSessionByWc.get(wcId) !== session ||
            !allowedByWc.get(wcId)?.has(path)
          ) {
            await clearPdfRecovery(crashRecoveryDir(), path)
            return { ok: false, error: 'pdf: recovery superseded' }
          }
          return { ok: true }
        })
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  )

  ipcMain.handle(
    PDF_CHANNELS.extractPages,
    async (e, raw: unknown): Promise<ExtractPagesResult> => {
      let request: ExtractPagesRequest
      try {
        request = parseExtractPagesRequest(raw)
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
      const { path, pages, suggestedName } = request
      if (!allowedByWc.get(e.sender.id)?.has(path)) {
        return { ok: false, error: 'pdf: path not granted to this view' }
      }
      const win =
        BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getFocusedWindow() ?? undefined
      const picked = await dialog.showSaveDialog(win!, {
        title: tm('dlgExtract'),
        defaultPath: join(dirname(path), String(suggestedName || 'pages.pdf')),
        filters: [{ name: tm('filterPdf'), extensions: ['pdf'] }],
      })
      if (picked.canceled || !picked.filePath) return { ok: true, canceled: true }
      try {
        const wcId = e.sender.id
        const session = await sourceSession(wcId, path)
        const transformed = await runPdfJob(wcId, () => ({
          kind: 'extract',
          source: {
            path: session.snapshotPath,
            byteLength: session.diskState.size,
            sha256: session.diskState.sha256,
          },
          pages,
        }))
        if (sourceSessionByWc.get(wcId) !== session || !allowedByWc.get(wcId)?.has(path)) {
          throw new Error('pdf: extract superseded')
        }
        await atomicWrite(picked.filePath, transformed.bytes)
        return { ok: true, savedPath: picked.filePath }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  ipcMain.handle(PDF_CHANNELS.insertPdf, async (e, raw: unknown): Promise<InsertPdfResult> => {
    let request: InsertPdfRequest
    try {
      request = parseInsertPdfRequest(raw)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    const { path, afterPageIndex } = request
    if (!allowedByWc.get(e.sender.id)?.has(path)) {
      return { ok: false, error: 'pdf: path not granted to this view' }
    }
    const win =
      BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getFocusedWindow() ?? undefined
    const picked = await dialog.showOpenDialog(win!, {
      title: tm('dlgInsert'),
      filters: [{ name: tm('filterPdf'), extensions: ['pdf'] }],
      properties: ['openFile'],
    })
    const other = picked.filePaths[0]
    if (picked.canceled || !other) return { ok: true, canceled: true }
    try {
      const wcId = e.sender.id
      const session = await sourceSession(wcId, path)
      if (await pdfSourceChanged(session.diskState, path)) {
        return {
          ok: false,
          error: 'The PDF changed in another app. Reopen it before inserting pages.',
        }
      }
      const transformed = await runPdfJob(wcId, async () => {
        const otherState = await capturePdfDiskState(other)
        if (otherState.size > PDF_MAX_EDIT_SOURCE_BYTES) {
          throw new Error('pdf: files over 64MB are view-only for memory safety')
        }
        return {
          kind: 'insert',
          source: {
            path: session.snapshotPath,
            byteLength: session.diskState.size,
            sha256: session.diskState.sha256,
          },
          other: { path: other, byteLength: otherState.size, sha256: otherState.sha256 },
          afterPageIndex,
        }
      })
      return await runPdfMutationSerial(path, async (): Promise<InsertPdfResult> => {
        if (sourceSessionByWc.get(wcId) !== session || !allowedByWc.get(wcId)?.has(path)) {
          return {
            ok: false,
            error: 'The PDF changed in another app. Reopen it before inserting pages.',
          }
        }
        const committed = await replacePdfIfUnchanged({
          sourcePath: path,
          expectedState: session.diskState,
          replacementBytes: transformed.bytes,
        })
        if (committed.kind === 'changed') {
          const recoveryPath = conflictRecoveryPathFor(path)
          await prunePrivateArtifacts(dirname(recoveryPath), {
            keepPaths: [recoveryPath],
            maxFiles: 32,
            maxBytes: 512 * 1024 * 1024,
            maxAgeMs: 30 * 24 * 60 * 60 * 1_000,
            reserveBytes: transformed.bytes.byteLength,
          })
          await atomicWrite(recoveryPath, transformed.bytes, { private: true })
          return {
            ok: false,
            error: `The PDF changed in another app. The original was not overwritten. Your merged recovery copy is at ${recoveryPath}.`,
          }
        }
        await refreshSourceSession(wcId, path)
        await clearCrashRecovery(path).catch(() => undefined)
        return { ok: true, insertedCount: transformed.insertedCount ?? 0 }
      })
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(
    PDF_CHANNELS.exportImages,
    async (e, raw: unknown): Promise<ExportImagesResult> => {
      let request: ExportImagesRequest
      try {
        request = parseExportImagesRequest(raw)
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
      const { images, pageNumbers, baseName } = request
      const win =
        BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getFocusedWindow() ?? undefined
      const picked = await dialog.showOpenDialog(win!, {
        title: tm('dlgExportImages'),
        properties: ['openDirectory', 'createDirectory'],
      })
      const dir = picked.filePaths[0]
      if (picked.canceled || !dir) return { ok: true, canceled: true }
      try {
        const safeBase = String(baseName || 'page').replace(/[/\\:*?"<>|]/g, '_')
        for (const [i, b64] of images.entries()) {
          const no = pageNumbers?.[i] ?? i + 1
          await atomicWrite(join(dir, `${safeBase}-p${no}.png`), Buffer.from(b64, 'base64'))
        }
        return { ok: true, savedDir: dir, count: images.length }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  ipcMain.on(PDF_CHANNELS.dirtyChanged, (e, dirty: unknown) => {
    if (dirty === true) dirtyByWc.add(e.sender.id)
    else dirtyByWc.delete(e.sender.id)
  })

  ipcMain.on(PDF_CHANNELS.closeSaveResult, (e, ok: unknown) => {
    const waiter = closeSaveWaiters.get(e.sender.id)
    closeSaveWaiters.delete(e.sender.id)
    waiter?.(ok === true)
  })

  ipcMain.on(PDF_CHANNELS.saveAsResult, (e, ok: unknown) => {
    const waiter = saveAsWaiters.get(e.sender.id)
    saveAsWaiters.delete(e.sender.id)
    waiter?.(ok === true)
  })

  // Language channel shared with other modules; removeHandler tolerates duplicate registration
  ipcMain.removeHandler(PDF_CHANNELS.getLanguage)
  ipcMain.handle(PDF_CHANNELS.getLanguage, () => getUiLang())
}

function grantAndTrack(wc: WebContents, openPath?: string | null): void {
  const wcId = wc.id
  if (openPath) repairInterruptedPdfCommitSync(openPath)
  const canonicalOpenPath = (() => {
    try {
      return openPath && existsSync(openPath) ? realpathSync(openPath) : null
    } catch {
      return null
    }
  })()
  if (canonicalOpenPath) {
    pendingByWc.set(wcId, canonicalOpenPath)
    allowedByWc.set(wcId, new Set([canonicalOpenPath]))
  }
  // External links inside the PDF (Link annots with target=_blank) go to the system browser
  wc.setWindowOpenHandler(({ url }) => {
    const target = safeExternalUrl(url, { allowedProtocols: ['http:', 'https:', 'mailto:'] })
    if (target) void shell.openExternal(target)
    return { action: 'deny' }
  })
  wc.once('destroyed', () => {
    cancelPdfJobs(wcId)
    pendingByWc.delete(wcId)
    allowedByWc.delete(wcId)
    dirtyByWc.delete(wcId)
    saveAsTargetByWc.delete(wcId)
    closeSaveWaiters.get(wcId)?.(false)
    closeSaveWaiters.delete(wcId)
    saveAsWaiters.get(wcId)?.(false)
    saveAsWaiters.delete(wcId)
    const source = sourceSessionByWc.get(wcId)
    sourceSessionByWc.delete(wcId)
    snapshotReservationByWc.delete(wcId)
    if (source) void rm(source.snapshotPath, { force: true })
  })
}

export function createPdfView(openPath?: string | null): WebContentsView {
  registerPdfIpc()
  const view = new WebContentsView({
    webPreferences: {
      preload: runtime.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  grantAndTrack(view.webContents, openPath)
  if (runtime.rendererUrl) void view.webContents.loadURL(runtime.rendererUrl)
  else if (runtime.rendererFile) void view.webContents.loadFile(runtime.rendererFile)
  return view
}

/** Standalone window mode: `npm run dev -w @genoffice/pdf`, pdf path passed via argv */
export function startPdfStandalone(): void {
  installNavigationGuard(app)
  installContextMenu(app, () => contextMenuLabels(getUiLang()))
  app.setPath('userData', join(app.getPath('appData'), 'GenOffice PDF'))
  configurePdfRuntime({
    preloadPath: join(__dirname, '../preload/index.js'),
    jobPreloadPath: join(__dirname, '../preload/job.js'),
    rendererUrl: process.env.ELECTRON_RENDERER_URL,
    rendererFile: join(__dirname, '../renderer/index.html'),
  })
  void app.whenReady().then(() => {
    registerPdfIpc()
    const win = new BrowserWindow({
      width: 1200,
      height: 850,
      webPreferences: {
        preload: runtime.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    const argPath = process.argv.slice(1).find((candidate) => {
      if (!/\.pdf$/i.test(candidate)) return false
      repairInterruptedPdfCommitSync(candidate)
      return existsSync(candidate)
    })
    grantAndTrack(win.webContents, argPath)
    if (runtime.rendererUrl) void win.loadURL(runtime.rendererUrl)
    else if (runtime.rendererFile) void win.loadFile(runtime.rendererFile)
  })
  app.on('window-all-closed', () => app.quit())
}

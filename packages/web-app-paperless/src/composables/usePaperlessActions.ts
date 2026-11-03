import {
  ApplicationSetupOptions,
  FileAction,
  FileActionOptions,
  formatFileSize,
  OcMinimalUppyFile,
  resolveFileNameDuplicate,
  UppyService,
  useClientService,
  useLoadingService,
  useMessages,
  useResourcesStore,
  useService,
  useUserStore
} from '@opencloud-eu/web-pkg'
import { computed } from 'vue'
import { useGettext } from 'vue3-gettext'
import { extractNameWithoutExtension } from '@opencloud-eu/web-client'

/**
 * Paperless integration, two actions:
 * - "Send to Paperless": one-way POST to the consume endpoint (document is
 *   archived + OCR'd in Paperless, nothing comes back).
 * - "Scan with Paperless (OCR)": round-trip — consume, poll until the
 *   document appears, download the archive version (OCR text layer) and
 *   save it next to the original.
 *
 * Authentication is NOT handled here: baseUrl is expected to point at a
 * reverse-proxy route that injects the Paperless API token and CORS headers.
 */
interface PaperlessConfig {
  baseUrl: string
  pollIntervalSeconds: number
  timeoutSeconds: number
  ocrSuffix: string
  maxSize: number
}

const DEFAULT_MAX_SIZE_MB = 100
const ACCEPTED_MIME_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/tiff',
  'image/webp',
  'image/gif',
  'text/plain'
]

const parseConfig = (applicationConfig: Record<string, unknown> | undefined): PaperlessConfig => {
  const baseUrl =
    typeof applicationConfig?.baseUrl === 'string' && applicationConfig.baseUrl.length > 0
      ? applicationConfig.baseUrl.replace(/\/+$/, '')
      : 'https://paperless.carrio.me/ext'
  const num = (value: unknown, fallback: number) => {
    const n = Number(value)
    return n > 0 ? n : fallback
  }
  return {
    baseUrl,
    pollIntervalSeconds: num(applicationConfig?.pollIntervalSeconds, 5),
    timeoutSeconds: num(applicationConfig?.timeoutSeconds, 300),
    ocrSuffix:
      typeof applicationConfig?.ocrSuffix === 'string' ? applicationConfig.ocrSuffix : '-ocr',
    maxSize: num(applicationConfig?.maxSize, DEFAULT_MAX_SIZE_MB * 1000000)
  }
}

const sleep = (seconds: number) => new Promise((resolve) => setTimeout(resolve, seconds * 1000))

export const usePaperlessActions = ({ applicationConfig }: ApplicationSetupOptions) => {
  const { $gettext, current: currentLanguage } = useGettext()
  const { baseUrl, pollIntervalSeconds, timeoutSeconds, ocrSuffix, maxSize } =
    parseConfig(applicationConfig)

  const clientService = useClientService()
  const loadingService = useLoadingService()
  const userStore = useUserStore()
  const resourcesStore = useResourcesStore()
  const { showErrorMessage, showMessage } = useMessages()
  const uppyService = useService<UppyService>('$uppyService')

  const getFileBlob = async ({ space, resources }: FileActionOptions) => {
    const { response } = await clientService.webdav.getFileContents(
      space,
      { path: resources[0].path },
      // responseType defaults to "text" (web-client), which mangles
      // binary through UTF-8 — Paperless then rejects the upload with
      // InputFileError. Always fetch blobs.
      { responseType: 'blob' }
    )
    return new File([response.data as Blob], resources[0].name, {
      type: resources[0].mimeType || 'application/octet-stream'
    })
  }

  /**
   * POST to the consume endpoint. Returns the celery task id on
   * paperless-ngx versions that report one (2.15+: JSON string body),
   * null otherwise (older versions answer plain text) — the OCR
   * round-trip then falls back to filename polling.
   */
  const consume = async (file: File): Promise<string | null> => {
    const form = new FormData()
    form.append('document', file, file.name)
    const response = await fetch(`${baseUrl}/api/documents/post_document/`, {
      method: 'POST',
      body: form
    })
    if (!response.ok) {
      throw new Error(`Paperless consume responded ${response.status}`)
    }
    const text = (await response.text()).replace(/^"|"$/g, '')
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)
    return isUuid ? text : null
  }

  /**
   * Wait for consumption to finish and return the new document id.
   *
   * Fast path (paperless-ngx >= 2.15): poll the celery task returned by
   * the consume endpoint — FAILURE surfaces the backend error within one
   * poll interval instead of running the full timeout. Once the task
   * SUCCEEDS, resolve the document via the filename listing.
   *
   * Fallback (no task id): poll the documents list by original filename
   * until the consumed document appears. Newest match wins; correlation
   * by filename is acceptable for a single-user instance.
   */
  const waitForDocument = async (file: File, taskId: string | null): Promise<number> => {
    const deadline = Date.now() + timeoutSeconds * 1000
    const listUrl = `${baseUrl}/api/documents/?original_filename=${encodeURIComponent(
      file.name
    )}&ordering=-created&page_size=1`
    const taskUrl = taskId
      ? `${baseUrl}/api/tasks/?task_id=${encodeURIComponent(taskId)}&page_size=1`
      : null
    let taskSucceeded = taskUrl === null

    while (Date.now() < deadline) {
      await sleep(pollIntervalSeconds)

      if (!taskSucceeded && taskUrl) {
        const response = await fetch(taskUrl)
        if (response.ok) {
          const data = (await response.json()) as {
            results?: Array<{ status?: string; result?: string }>
          }
          const task = data.results?.[0]
          if (task?.status === 'FAILURE' || task?.status === 'REVOKED') {
            throw new Error(task.result || `Consume task ${task.status}`)
          }
          taskSucceeded = task?.status === 'SUCCESS'
        }
      }
      if (!taskSucceeded) {
        continue
      }

      const response = await fetch(listUrl)
      if (!response.ok) {
        continue
      }
      const data = (await response.json()) as { results?: Array<{ id: number }> }
      const doc = data.results?.[0]
      if (doc) {
        return doc.id
      }
    }
    throw new Error(
      `Timed out after ${timeoutSeconds}s waiting for Paperless to consume ${file.name} — check File Tasks in Paperless`
    )
  }

  const downloadArchive = async (id: number): Promise<Blob> => {
    const response = await fetch(`${baseUrl}/api/documents/${id}/download/`)
    if (!response.ok) {
      throw new Error(`Paperless download responded ${response.status}`)
    }
    return response.blob()
  }

  const queueHandler = async (args: FileActionOptions) => {
    try {
      const file = await getFileBlob(args)
      await consume(file)
      showMessage({ title: $gettext('Sent "%{name}" to Paperless', { name: file.name }) })
    } catch (error) {
      showErrorMessage({
        title: $gettext('Failed to send document to Paperless'),
        errors: [error]
      })
    }
  }

  const ocrHandler = async (args: FileActionOptions) => {
    try {
      const file = await getFileBlob(args)
      const taskId = await consume(file)
      const id = await waitForDocument(file, taskId)
      const blob = await downloadArchive(id)
      const base = `${extractNameWithoutExtension(args.resources[0])}${ocrSuffix}`
      const name = resolveFileNameDuplicate(base, 'pdf', resourcesStore.resources)
      uppyService.addFiles([
        {
          name,
          data: blob,
          meta: { uploadId: crypto.randomUUID() }
        } as unknown as OcMinimalUppyFile
      ])
    } catch (error) {
      showErrorMessage({
        title: $gettext('Paperless OCR round-trip failed'),
        errors: [error]
      })
    }
  }

  const isVisible = ({ resources }: FileActionOptions) => {
    if (resources.length !== 1) {
      return false
    }
    if (!ACCEPTED_MIME_TYPES.includes(resources[0].mimeType)) {
      return false
    }
    return resourcesStore.currentFolder?.canUpload({ user: userStore.user }) === true
  }

  const isVisibleOcr = (args: FileActionOptions) =>
    isVisible(args) && Number(args.resources[0].size || 0) <= maxSize

  return computed<FileAction[]>(() => [
    {
      name: 'paperless-queue',
      icon: 'upload-cloud-2',
      handler: (args: FileActionOptions) => loadingService.addTask(() => queueHandler(args)),
      label: () => $gettext('Send to Paperless'),
      isDisabled: ({ resources }) => Number(resources[0].size || 0) > maxSize,
      disabledTooltip: () =>
        $gettext('File exceeds the maximum size of %{maxSize}', {
          maxSize: formatFileSize(maxSize, currentLanguage)
        }),
      isVisible,
      componentType: 'button',
      class: 'oc-files-actions-paperless-queue'
    },
    {
      name: 'paperless-ocr',
      icon: 'file-search',
      handler: (args: FileActionOptions) => loadingService.addTask(() => ocrHandler(args)),
      label: () => $gettext('Scan with Paperless (OCR)'),
      isDisabled: ({ resources }) => Number(resources[0].size || 0) > maxSize,
      disabledTooltip: () =>
        $gettext('File exceeds the maximum size of %{maxSize}', {
          maxSize: formatFileSize(maxSize, currentLanguage)
        }),
      isVisible: isVisibleOcr,
      componentType: 'button',
      class: 'oc-files-actions-paperless-ocr'
    }
  ])
}

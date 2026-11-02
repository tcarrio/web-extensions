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
    const { response } = await clientService.webdav.getFileContents(space, {
      path: resources[0].path
    })
    return new File([response.data as Blob], resources[0].name, {
      type: resources[0].mimeType || 'application/octet-stream'
    })
  }

  const consume = async (file: File) => {
    const form = new FormData()
    form.append('document', file, file.name)
    const response = await fetch(`${baseUrl}/api/documents/post_document/`, {
      method: 'POST',
      body: form
    })
    if (!response.ok) {
      throw new Error(`Paperless consume responded ${response.status}`)
    }
  }

  /**
   * Poll the documents list by original filename until the consumed document
   * appears (consumption is asynchronous). Newest match wins; correlation by
   * filename is acceptable for a single-user instance.
   */
  const waitForDocument = async (file: File): Promise<number> => {
    const deadline = Date.now() + timeoutSeconds * 1000
    const listUrl = `${baseUrl}/api/documents/?original_filename=${encodeURIComponent(
      file.name
    )}&ordering=-created&page_size=1`
    while (Date.now() < deadline) {
      await sleep(pollIntervalSeconds)
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
      `Timed out after ${timeoutSeconds}s waiting for Paperless to consume ${file.name}`
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
      await consume(file)
      const id = await waitForDocument(file)
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

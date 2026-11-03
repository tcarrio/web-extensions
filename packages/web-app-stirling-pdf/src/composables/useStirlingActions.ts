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
 * One Stirling operation exposed as a file action. Endpoint and params are
 * config-driven (`settings.apps."stirling-pdf".config`) so operation tweaks
 * are an apps.yaml edit, not an app rebuild.
 */
export interface StirlingOperation {
  /** stable action id, also used in the extension id */
  id: string
  /** context menu label */
  label: string
  /** Stirling endpoint, e.g. /api/v1/convert/pdf/word */
  endpoint: string
  /** extension of the produced file, e.g. docx */
  outputExtension: string
  /** operation takes 2+ selected files (merge); default single */
  multiple?: boolean
  /** query parameters appended to the endpoint, e.g. { outputFormat: "docx" } */
  params?: Record<string, string>
  /** output base name for multiple-file operations; default "merged" */
  outputName?: string
}

interface StirlingConfig {
  baseUrl: string
  operations: StirlingOperation[]
  maxSize: number
}

const DEFAULT_OPERATIONS: StirlingOperation[] = [
  {
    id: 'convert-word',
    label: 'Convert to Word',
    endpoint: '/api/v1/convert/pdf/word',
    outputExtension: 'docx',
    params: { outputFormat: 'docx' }
  },
  {
    id: 'convert-png',
    label: 'Convert to image (PNG)',
    endpoint: '/api/v1/convert/pdf/img/img',
    outputExtension: 'png',
    params: { imageFormat: 'png' }
  },
  {
    id: 'compress',
    label: 'Compress PDF',
    endpoint: '/api/v1/misc/compress-pdf',
    outputExtension: 'pdf'
  },
  {
    id: 'merge',
    label: 'Merge PDFs',
    endpoint: '/api/v1/general/merge-pdfs',
    outputExtension: 'pdf',
    multiple: true
  }
]

const DEFAULT_MAX_SIZE_MB = 100

const isPdf = (resource: { mimeType?: string; extension?: string }) =>
  resource.mimeType === 'application/pdf' || resource.extension === 'pdf'

const parseConfig = (applicationConfig: Record<string, unknown> | undefined): StirlingConfig => {
  const baseUrl =
    typeof applicationConfig?.baseUrl === 'string' && applicationConfig.baseUrl.length > 0
      ? applicationConfig.baseUrl.replace(/\/+$/, '')
      : 'https://pdfs.carrio.me'
  const operations =
    Array.isArray(applicationConfig?.operations) && applicationConfig.operations.length > 0
      ? (applicationConfig.operations as StirlingOperation[])
      : DEFAULT_OPERATIONS
  const configuredMaxSize = Number(applicationConfig?.maxSize)
  const maxSize = configuredMaxSize > 0 ? configuredMaxSize : DEFAULT_MAX_SIZE_MB * 1000000
  return { baseUrl, operations, maxSize }
}

export const useStirlingActions = ({ applicationConfig }: ApplicationSetupOptions) => {
  const { $gettext, current: currentLanguage } = useGettext()
  const { baseUrl, operations, maxSize } = parseConfig(applicationConfig)

  const clientService = useClientService()
  const loadingService = useLoadingService()
  const userStore = useUserStore()
  const resourcesStore = useResourcesStore()
  const { showErrorMessage } = useMessages()
  const uppyService = useService<UppyService>('$uppyService')

  const getFileBlob = async ({ space, resources }: FileActionOptions, index: number) => {
    const { response } = await clientService.webdav.getFileContents(
      space,
      { path: resources[index].path },
      // responseType defaults to "text" (web-client), which mangles
      // binary through UTF-8 — always fetch blobs.
      { responseType: 'blob' }
    )
    return new File([response.data as Blob], resources[index].name, {
      type: resources[index].mimeType || 'application/pdf'
    })
  }

  const buildHandler = (op: StirlingOperation) => {
    return async ({ space, resources }: FileActionOptions) => {
      try {
        const form = new FormData()
        const blobs = await Promise.all(
          resources.map((_, index) => getFileBlob({ space, resources }, index))
        )
        blobs.forEach((blob) => form.append('fileInput', blob, blob.name))

        const query = new URLSearchParams(op.params || {}).toString()
        const url = `${baseUrl}${op.endpoint}${query ? `?${query}` : ''}`
        const response = await fetch(url, { method: 'POST', body: form })
        if (!response.ok) {
          throw new Error(`Stirling PDF responded ${response.status} for ${op.endpoint}`)
        }
        const resultBlob = await response.blob()

        const base = op.multiple
          ? op.outputName || 'merged'
          : extractNameWithoutExtension(resources[0])
        const name = resolveFileNameDuplicate(base, op.outputExtension, resourcesStore.resources)
        const uploadId = crypto.randomUUID()
        uppyService.addFiles([
          { name, data: resultBlob, meta: { uploadId } } as unknown as OcMinimalUppyFile
        ])
      } catch (error) {
        showErrorMessage({
          title: $gettext('Stirling PDF operation "%{label}" failed', { label: op.label }),
          errors: [error]
        })
      }
    }
  }

  return computed<FileAction[]>(() =>
    operations.map((op) => {
      const minFiles = op.multiple ? 2 : 1
      const exact = !op.multiple
      return {
        name: `stirling-${op.id}`,
        icon: 'file-settings',
        handler: (args: FileActionOptions) => loadingService.addTask(() => buildHandler(op)(args)),
        label: () => $gettext(op.label),
        isDisabled: ({ resources }) =>
          resources.reduce((sum, r) => sum + Number(r.size || 0), 0) > maxSize,
        disabledTooltip: () =>
          $gettext('Selection exceeds the maximum size of %{maxSize}', {
            maxSize: formatFileSize(maxSize, currentLanguage)
          }),
        isVisible: ({ resources }) => {
          if (resources.length < minFiles) {
            return false
          }
          if (exact && resources.length !== 1) {
            return false
          }
          if (!resources.every(isPdf)) {
            return false
          }
          return resourcesStore.currentFolder?.canUpload({ user: userStore.user }) === true
        },
        componentType: 'button',
        class: 'oc-files-actions-stirling-pdf'
      }
    })
  )
}

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
  /**
   * overwrite the original in place instead of saving a new file next
   * to it (server keeps a version). Only sensible for pdf -> pdf.
   */
  inPlace?: boolean
  /**
   * nest the operation under a parent context-menu entry with this
   * label (all operations sharing a group label share one submenu).
   */
  group?: string
  /** query parameters appended to the endpoint, e.g. { outputFormat: "docx" } */
  params?: Record<string, string>
  /**
   * multipart form fields besides fileInput (many Stirling endpoints
   * mark these required). Values: string, or string[] for repeated
   * fields (e.g. OCR languages).
   */
  form?: Record<string, string | string[]>
  /** output base name for multiple-file operations; default "merged" */
  outputName?: string
}

interface StirlingConfig {
  baseUrl: string
  operations: StirlingOperation[]
  maxSize: number
}

// Verified against the live instance's swagger (/v1/api-docs,
// Stirling 2.14.3) — several endpoints mark operation fields as
// REQUIRED and reject the request without them.
export const DEFAULT_OPERATIONS: StirlingOperation[] = [
  {
    id: 'compress',
    label: 'Compress (in place)',
    endpoint: '/api/v1/misc/compress-pdf',
    outputExtension: 'pdf',
    inPlace: true,
    form: { optimizeLevel: '5', expectedOutputSize: '100MB' }
  },
  {
    id: 'ocr',
    label: 'OCR (in place)',
    endpoint: '/api/v1/misc/ocr-pdf',
    outputExtension: 'pdf',
    inPlace: true,
    form: { languages: ['eng'], ocrType: 'skip-text', ocrRenderType: 'hocr' }
  },
  {
    id: 'rotate-90',
    label: 'Rotate 90°',
    endpoint: '/api/v1/general/rotate-pdf',
    outputExtension: 'pdf',
    inPlace: true,
    form: { angle: '90' }
  },
  {
    id: 'repair',
    label: 'Repair (in place)',
    endpoint: '/api/v1/misc/repair',
    outputExtension: 'pdf',
    inPlace: true
  },
  {
    id: 'convert-word',
    label: 'Convert to Word',
    endpoint: '/api/v1/convert/pdf/word',
    outputExtension: 'docx',
    form: { outputFormat: 'docx' }
  },
  {
    id: 'convert-pptx',
    label: 'Convert to PowerPoint',
    endpoint: '/api/v1/convert/pdf/presentation',
    outputExtension: 'pptx',
    form: { outputFormat: 'pptx' }
  },
  {
    id: 'convert-png',
    label: 'Convert to image (PNG)',
    endpoint: '/api/v1/convert/pdf/img',
    outputExtension: 'png',
    form: {
      pageNumbers: 'all',
      imageFormat: 'png',
      singleOrMultiple: 'single',
      colorType: 'color',
      dpi: '150'
    }
  },
  {
    id: 'merge',
    label: 'Merge PDFs',
    endpoint: '/api/v1/general/merge-pdfs',
    outputExtension: 'pdf',
    multiple: true,
    form: { sortType: 'orderProvided', removeCertSign: 'false' }
  }
]

const DEFAULT_MAX_SIZE_MB = 100

const isPdf = (resource: { mimeType?: string; extension?: string }) =>
  resource.mimeType === 'application/pdf' || resource.extension === 'pdf'

export const parseConfig = (
  applicationConfig: Record<string, unknown> | undefined
): StirlingConfig => {
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
        Object.entries(op.form || {}).forEach(([key, value]) => {
          const values = Array.isArray(value) ? value : [value]
          values.forEach((v) => form.append(key, v))
        })

        const query = new URLSearchParams(op.params || {}).toString()
        const url = `${baseUrl}${op.endpoint}${query ? `?${query}` : ''}`
        const response = await fetch(url, { method: 'POST', body: form })
        if (!response.ok) {
          throw new Error(`Stirling PDF responded ${response.status} for ${op.endpoint}`)
        }
        const resultBlob = await response.blob()

        if (op.inPlace) {
          // pdf -> pdf: overwrite the original — the server keeps a
          // version. Update the existing store resource in place (its
          // object carries the client-side helper methods like
          // canShare(); replacing it with the plain putFileContents
          // result breaks the files UI with "canShare is not a
          // function").
          const updated = await clientService.webdav.putFileContents(space, {
            path: resources[0].path,
            content: await resultBlob.arrayBuffer(),
            overwrite: true
          })
          resources[0].size = updated.size
          resources[0].etag = updated.etag
          return
        }

        const base = op.multiple
          ? op.outputName || 'merged'
          : extractNameWithoutExtension(resources[0])
        // resolveFileNameDuplicate ALWAYS appends " (n)" — its conflict
        // check only looks at the suffixed name. Only dedupe when the
        // plain name actually collides.
        const plainName = `${base}.${op.outputExtension}`
        const name = resourcesStore.resources.some((r) => r.name === plainName)
          ? resolveFileNameDuplicate(plainName, op.outputExtension, resourcesStore.resources)
          : plainName
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

  const buildAction = (op: StirlingOperation): FileAction => {
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
      class: 'oc-files-actions-stirling-pdf'
    }
  }

  return computed<FileAction[]>(() => {
    const actions = operations.map(buildAction)

    // group ops under one parent entry per shared group label; the
    // files UI renders Action.children as a nested context menu.
    // Ungrouped ops stay top-level.
    const groups = new Map<string, { ops: typeof operations; actions: FileAction[] }>()
    const top: FileAction[] = []
    operations.forEach((op, i) => {
      if (!op.group) {
        top.push(actions[i])
        return
      }
      const group = groups.get(op.group) || { ops: [], actions: [] }
      group.ops.push(op)
      group.actions.push(actions[i])
      groups.set(op.group, group)
    })

    const parents: FileAction[] = []
    groups.forEach((group, label) => {
      parents.push({
        name: `stirling-group-${group.ops[0].id}`,
        icon: 'file-settings',
        label: () => $gettext(label),
        children: group.actions,
        // the parent shows whenever ANY child would (the web client
        // filters the submenu items by the same isVisible) — a
        // single-file-ops group with one multi-select op (merge) must
        // still appear on multi selections
        isVisible: (options: FileActionOptions) => group.actions.some((a) => a.isVisible(options)),
        class: 'oc-files-actions-stirling-pdf-group'
      })
    })

    return [...top, ...parents]
  })
}

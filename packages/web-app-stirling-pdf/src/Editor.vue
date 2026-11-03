<template>
  <div class="stirling-pdf-editor oc-py-m oc-px-m">
    <div
      class="stirling-pdf-editor-toolbar oc-mb-m"
      style="display: flex; gap: 8px; align-items: center"
    >
      <button class="oc-button" :disabled="loading || saving" @click="save">
        {{ $gettext('Save') }}
      </button>
      <button class="oc-button" :disabled="loading || saving" @click="$emit('close')">
        {{ $gettext('Close') }}
      </button>
      <span v-if="loading">{{ $gettext('Loading document…') }}</span>
      <span v-else-if="saving">{{ $gettext('Saving…') }}</span>
      <span v-else-if="error" class="stirling-pdf-editor-error">{{ error }}</span>
      <span v-else style="margin-left: auto">
        {{ $gettext('Page') }}
        <select v-model="currentPage" :disabled="loading">
          <option v-for="n in pageNumbers" :key="n" :value="n">{{ n }}</option>
        </select>
        {{ $gettext('of %{total}', { total: String(pageNumbers.length) }) }}
      </span>
    </div>

    <div v-if="page" class="stirling-pdf-editor-page" :style="pageStyle">
      <img v-if="pageImage" :src="pageImage" class="stirling-pdf-editor-pageimg" alt="" />
      <div
        v-for="(element, index) in page.textElements"
        :key="index"
        class="stirling-pdf-editor-text"
        :style="elementStyle(element)"
      >
        <input v-model="element.text" :style="inputStyle(element)" :title="elementTitle(element)" />
      </div>
    </div>
    <p v-else-if="!loading && !error">
      {{ $gettext('No editable text found on this page.') }}
    </p>
  </div>
</template>

<script lang="ts">
import { defineComponent, PropType, ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { Resource } from '@opencloud-eu/web-client'
import {
  AppConfigObject,
  useClientService,
  useMessages,
  useResourcesStore,
  useSpacesStore
} from '@opencloud-eu/web-pkg'
import { useGettext } from 'vue3-gettext'
import { parseConfig } from './composables/useStirlingActions'

interface TextElement {
  text: string
  fontId: string
  fontSize?: number
  width: number
  height: number
  textMatrix: number[]
  [key: string]: unknown
}

interface PageJson {
  pageNumber: number
  width: number
  height: number
  rotation: number
  textElements: TextElement[]
  [key: string]: unknown
}

interface DocumentJson {
  metadata: Record<string, unknown>
  xmpMetadata?: string
  lazyImages?: boolean
  fonts?: unknown[]
  pages: PageJson[]
  formFields?: unknown
}

/**
 * Interactive PDF text editor on Stirling's text-editor session API
 * (server-side rendering, verified 2026-11-03 — no client-side pdfium):
 * convert (async job) -> poll -> lazy page JSON per page, page PNG via
 * the image endpoint as background, edited textElements posted to
 * partial/{jobId} which re-renders the PDF server-side.
 */
export default defineComponent({
  name: 'StirlingPdfEditor',
  props: {
    resource: {
      type: Object as PropType<Resource>,
      required: true
    },
    applicationConfig: {
      type: Object as PropType<AppConfigObject>,
      required: false,
      default: (): AppConfigObject => undefined
    }
  },
  emits: ['close'],
  setup(props) {
    const { $gettext } = useGettext()
    const { baseUrl } = parseConfig(props.applicationConfig)

    const clientService = useClientService()
    const resourcesStore = useResourcesStore()
    const spacesStore = useSpacesStore()
    const { showErrorMessage, showMessage } = useMessages()

    const loading = ref(true)
    const saving = ref(false)
    const error = ref('')
    const jobId = ref('')
    const doc = ref<DocumentJson | null>(null)
    const pages = ref<Map<number, PageJson>>(new Map())
    const pageImages = ref<Map<number, string>>(new Map())
    const currentPage = ref(1)
    const displayWidth = 900

    const pageNumbers = computed(() => {
      const count = Number(doc.value?.metadata?.numberOfPages || 0)
      return Array.from({ length: count }, (_, i) => i + 1)
    })

    const page = computed(() => pages.value.get(currentPage.value) || null)
    const pageImage = computed(() => pageImages.value.get(currentPage.value) || '')

    const scale = computed(() => {
      if (!page.value?.width) return 1
      return displayWidth / page.value.width
    })

    const pageStyle = computed((): Record<string, string> => {
      if (!page.value) return {}
      return {
        position: 'relative',
        width: `${displayWidth}px`,
        height: `${page.value.height * scale.value}px`,
        background: '#e8e8e8',
        'box-shadow': '0 0 5px rgba(0,0,0,.3)',
        'margin-bottom': '16px'
      }
    })

    const elementStyle = (element: TextElement): Record<string, string> => {
      const tm = element.textMatrix || [0, 0, 0, 0, 0, 0]
      const x = (tm[4] || 0) * scale.value
      // PDF origin is bottom-left; CSS is top-left
      const yTop = (page.value.height - (tm[5] || 0) - element.height) * scale.value
      return {
        position: 'absolute',
        left: `${Math.max(0, x)}px`,
        top: `${Math.max(0, yTop)}px`,
        width: `${Math.max(40, element.width * scale.value)}px`
      }
    }

    const inputStyle = (element: TextElement): Record<string, string> => {
      const fontSizePt = element.textMatrix?.[3] || element.fontSize || 12
      return {
        // PDF points -> CSS px
        fontSize: `${fontSizePt * scale.value * (96 / 72)}px`,
        padding: '0',
        margin: '0',
        background: 'rgba(255,255,50,.25)',
        border: 'none',
        outline: '1px dashed rgba(0,0,0,.25)',
        width: '100%',
        color: '#000'
      }
    }

    const elementTitle = (element: TextElement) =>
      `${element.fontId} · ${element.textMatrix?.[3] || element.fontSize || '?'}pt`

    const space = computed(() => spacesStore.spaces.find((s) => s.id === props.resource.storageId))

    let fileBlob: Blob | null = null

    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

    const load = async () => {
      loading.value = true
      error.value = ''
      try {
        if (!space.value) {
          throw new Error('Could not resolve the space of this file')
        }
        const { response } = await clientService.webdav.getFileContents(
          space.value,
          { path: props.resource.path },
          { responseType: 'blob' }
        )
        fileBlob = response.data as Blob

        const form = new FormData()
        form.append(
          'fileInput',
          new File([fileBlob], props.resource.name, { type: 'application/pdf' }),
          props.resource.name
        )
        const convertResponse = await fetch(
          `${baseUrl}/api/v1/convert/pdf/text-editor?async=true&lightweight=true`,
          { method: 'POST', body: form }
        )
        if (!convertResponse.ok) {
          throw new Error(`convert responded ${convertResponse.status}`)
        }
        const { jobId: id } = (await convertResponse.json()) as { jobId: string }
        jobId.value = id

        for (let attempt = 0; attempt < 120; attempt++) {
          await sleep(1500)
          const statusResponse = await fetch(`${baseUrl}/api/v1/general/job/${id}`)
          if (!statusResponse.ok) {
            continue
          }
          const status = (await statusResponse.json()) as { complete: boolean; error: string }
          if (status.error) {
            throw new Error(status.error)
          }
          if (status.complete) {
            break
          }
        }

        const resultResponse = await fetch(`${baseUrl}/api/v1/general/job/${id}/result`)
        if (!resultResponse.ok) {
          throw new Error(`job result responded ${resultResponse.status}`)
        }
        doc.value = (await resultResponse.json()) as DocumentJson
        await Promise.all([loadPage(1)])
        currentPage.value = 1
      } catch (e) {
        error.value = e instanceof Error ? e.message : String(e)
        showErrorMessage({
          title: $gettext('Failed to open the document in Stirling PDF'),
          errors: [e instanceof Error ? e : new Error(String(e))]
        })
      } finally {
        loading.value = false
      }
    }

    const loadPage = async (n: number) => {
      if (!jobId.value || pages.value.has(n)) {
        return
      }
      const [pageResponse] = await Promise.all([
        fetch(`${baseUrl}/api/v1/convert/pdf/text-editor/page/${jobId.value}/${n}`)
      ])
      if (!pageResponse.ok) {
        throw new Error(`page ${n} responded ${pageResponse.status}`)
      }
      const pageJson = (await pageResponse.json()) as PageJson
      pages.value.set(n, pageJson)
      pageImages.value.set(n, await renderPageImage(n))
    }

    const renderPageImage = async (n: number): Promise<string> => {
      try {
        const form = new FormData()
        form.append(
          'fileInput',
          new File([fileBlob as Blob], props.resource.name, { type: 'application/pdf' }),
          props.resource.name
        )
        const response = await fetch(
          `${baseUrl}/api/v1/convert/pdf/img?pageNumbers=${n}&imageFormat=png&singleOrMultiple=single&colorType=color&dpi=110`,
          { method: 'POST', body: form }
        )
        if (!response.ok) {
          return ''
        }
        return URL.createObjectURL(await response.blob())
      } catch {
        return ''
      }
    }

    const save = async () => {
      saving.value = true
      error.value = ''
      try {
        if (!doc.value || !jobId.value) {
          throw new Error('Document not loaded')
        }
        const payload: DocumentJson = {
          ...doc.value,
          pages: [...pages.value.values()].sort((a, b) => a.pageNumber - b.pageNumber)
        }
        const response = await fetch(
          `${baseUrl}/api/v1/convert/pdf/text-editor/partial/${jobId.value}?filename=${encodeURIComponent(
            props.resource.name
          )}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          }
        )
        if (!response.ok) {
          throw new Error(`save responded ${response.status}`)
        }
        const blob = await response.blob()
        const updated = await clientService.webdav.putFileContents(space.value, {
          path: props.resource.path,
          content: await blob.arrayBuffer(),
          overwrite: true
        })
        // update the STORE's resource object (same object the prop
        // references) — never write props directly (vue/no-mutating-props)
        const storeResource = resourcesStore.resources.find((r) => r.id === props.resource.id)
        if (storeResource) {
          storeResource.size = updated.size
          storeResource.etag = updated.etag
        }
        showMessage({ title: $gettext('"%{name}" saved', { name: props.resource.name }) })
      } catch (e) {
        error.value = e instanceof Error ? e.message : String(e)
        showErrorMessage({
          title: $gettext('Failed to save the document'),
          errors: [e instanceof Error ? e : new Error(String(e))]
        })
      } finally {
        saving.value = false
      }
    }

    const clearCache = () => {
      if (jobId.value) {
        fetch(`${baseUrl}/api/v1/convert/pdf/text-editor/clear-cache/${jobId.value}`, {
          method: 'POST'
        }).catch((): void => undefined)
      }
      pageImages.value.forEach((url) => URL.revokeObjectURL(url))
    }

    onMounted(load)
    onBeforeUnmount(clearCache)

    return {
      loading,
      saving,
      error,
      pageNumbers,
      currentPage,
      page,
      pageImage,
      pageStyle,
      elementStyle,
      inputStyle,
      elementTitle,
      save
    }
  }
})
</script>

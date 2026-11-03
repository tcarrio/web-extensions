<template>
  <div class="stirling-pdf-picker oc-py-m">
    <h2 class="oc-mb-m oc-text-bold">{{ $gettext('Stirling PDF operations') }}</h2>
    <p class="oc-mb-m">
      {{
        $gettext(
          'Run an operation on "%{name}". Same-format results overwrite the file in place (a new version is kept); others are saved next to it.',
          {
            name: resource.name
          }
        )
      }}
    </p>
    <div class="stirling-pdf-picker-actions oc-mb-m">
      <button
        v-for="op in singleFileOperations"
        :key="op.id"
        :disabled="running"
        class="oc-button oc-mr-s oc-mb-s"
        @click="run(op)"
      >
        {{ $gettext(op.label) }}
      </button>
    </div>
    <p v-if="error" class="stirling-pdf-picker-error">{{ error }}</p>
    <p v-if="running">{{ $gettext('Working…') }}</p>
    <button class="oc-button" :disabled="running" @click="$emit('close')">
      {{ $gettext('Done') }}
    </button>
  </div>
</template>

<script lang="ts">
import { defineComponent, PropType, ref, computed, unref } from 'vue'
import { Resource, extractNameWithoutExtension } from '@opencloud-eu/web-client'
import {
  AppConfigObject,
  resolveFileNameDuplicate,
  OcMinimalUppyFile,
  UppyService,
  useClientService,
  useMessages,
  useResourcesStore,
  useService,
  useSpacesStore
} from '@opencloud-eu/web-pkg'
import { useGettext } from 'vue3-gettext'
import { parseConfig, StirlingOperation } from './composables/useStirlingActions'

/**
 * "Open With" view for PDFs: an operation launcher, not an interactive
 * editor — the Stirling UI has no file hand-in/hand-out protocol (no
 * URL-param loading, no postMessage), so editing is offloaded per
 * operation via the REST API instead.
 */
export default defineComponent({
  name: 'StirlingPdfPicker',
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
    const { baseUrl, operations } = parseConfig(props.applicationConfig)

    const clientService = useClientService()
    const resourcesStore = useResourcesStore()
    const spacesStore = useSpacesStore()
    const { showErrorMessage, showMessage } = useMessages()
    const uppyService = useService<UppyService>('$uppyService')

    const running = ref(false)
    const error = ref('')

    const singleFileOperations = computed<StirlingOperation[]>(() =>
      operations.filter((op) => !op.multiple)
    )

    const space = computed(() =>
      unref(spacesStore.spaces).find((s) => s.id === unref(props.resource).storageId)
    )

    const run = async (op: StirlingOperation) => {
      running.value = true
      error.value = ''
      try {
        const resource = unref(props.resource)
        if (!unref(space)) {
          throw new Error('Could not resolve the space of this file')
        }
        const { response } = await clientService.webdav.getFileContents(
          unref(space),
          { path: resource.path },
          { responseType: 'blob' }
        )
        const form = new FormData()
        form.append(
          'fileInput',
          new File([response.data as Blob], resource.name, {
            type: resource.mimeType || 'application/pdf'
          }),
          resource.name
        )
        const query = new URLSearchParams(op.params || {}).toString()
        const url = `${baseUrl}${op.endpoint}${query ? `?${query}` : ''}`
        const result = await fetch(url, { method: 'POST', body: form })
        if (!result.ok) {
          throw new Error(`Stirling PDF responded ${result.status} for ${op.endpoint}`)
        }
        const blob = await result.blob()

        if (op.outputExtension === 'pdf') {
          // same format: overwrite in place — the server keeps a version
          const updated = await clientService.webdav.putFileContents(unref(space), {
            path: resource.path,
            content: await blob.arrayBuffer(),
            overwrite: true
          })
          resourcesStore.upsertResource(updated)
          showMessage({ title: $gettext('"%{name}" updated', { name: resource.name }) })
        } else {
          const base = extractNameWithoutExtension(resource)
          const name = resolveFileNameDuplicate(base, op.outputExtension, resourcesStore.resources)
          uppyService.addFiles([
            {
              name,
              data: blob,
              meta: { uploadId: crypto.randomUUID() }
            } as unknown as OcMinimalUppyFile
          ])
          showMessage({ title: $gettext('"%{name}" saved next to the original', { name }) })
        }
      } catch (e) {
        error.value = e instanceof Error ? e.message : String(e)
        showErrorMessage({
          title: $gettext('Stirling PDF operation "%{label}" failed', { label: op.label }),
          errors: [e instanceof Error ? e : new Error(String(e))]
        })
      } finally {
        running.value = false
      }
    }

    return {
      singleFileOperations,
      running,
      error,
      run
    }
  }
})
</script>

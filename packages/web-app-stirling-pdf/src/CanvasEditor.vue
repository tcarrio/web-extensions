<template>
  <div class="stirling-pdf-canvas oc-py-m oc-px-m">
    <div class="oc-mb-m" style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap">
      <button
        v-for="t in tools"
        :key="t.id"
        class="oc-button"
        :style="tool === t.id ? 'font-weight: bold' : ''"
        :disabled="loading"
        @click="tool = t.id"
      >
        {{ t.label }}
      </button>
      <span style="width: 12px"></span>
      <button class="oc-button" :disabled="loading || saving" @click="save">
        {{ $gettext('Save') }}
      </button>
      <button class="oc-button" :disabled="loading || saving" @click="$emit('close')">
        {{ $gettext('Close') }}
      </button>
      <span style="margin-left: auto">
        <button
          class="oc-button"
          :disabled="loading || pageNum <= 1"
          @click="showPage(pageNum - 1)"
        >
          ‹
        </button>
        {{ pageNum }} / {{ pageCount }}
        <button
          class="oc-button"
          :disabled="loading || pageNum >= pageCount"
          @click="showPage(pageNum + 1)"
        >
          ›
        </button>
        <button
          class="oc-button"
          :disabled="loading || !items.length"
          :title="$gettext('Discard all edits')"
          @click="items = []"
        >
          {{ $gettext('Discard') }}
        </button>
      </span>
    </div>
    <p v-if="loading">{{ $gettext('Loading document…') }}</p>
    <p v-else-if="error" class="stirling-pdf-canvas-error">{{ error }}</p>
    <p v-else-if="hint" style="opacity: 0.7">{{ hint }}</p>

    <div
      v-show="!loading && !error && pageCount"
      class="stirling-pdf-canvas-stage"
      style="position: relative; display: inline-block; box-shadow: 0 0 5px rgba(0, 0, 0, 0.3)"
    >
      <canvas ref="baseCanvas"></canvas>
      <canvas
        ref="overlayCanvas"
        style="position: absolute; left: 0; top: 0"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
      ></canvas>
    </div>

    <div
      v-if="signing"
      style="
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.5);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 100;
      "
    >
      <div style="background: #fff; padding: 16px; border-radius: 8px; text-align: center">
        <p>{{ $gettext('Draw your signature') }}</p>
        <canvas
          ref="signatureCanvas"
          width="500"
          height="200"
          style="border: 1px solid #ccc; touch-action: none"
          @pointerdown="onSignDown"
          @pointermove="onSignMove"
          @pointerup="onSignUp"
        ></canvas>
        <div style="margin-top: 8px; display: flex; gap: 8px; justify-content: center">
          <button class="oc-button" @click="clearSignature">{{ $gettext('Clear') }}</button>
          <button class="oc-button" @click="signing = false">{{ $gettext('Cancel') }}</button>
          <button class="oc-button" style="font-weight: bold" @click="acceptSignature">
            {{ $gettext('Use signature') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, PropType, ref, computed, onMounted, nextTick } from 'vue'
import { Resource, SpaceResource } from '@opencloud-eu/web-client'
import {
  AppConfigObject,
  useClientService,
  useMessages,
  useResourcesStore
} from '@opencloud-eu/web-pkg'
import { useGettext } from 'vue3-gettext'
import { PDFDocument, rgb } from 'pdf-lib'

/**
 * Canvas editor: pdf.js renders pages, edits (rect highlight, freehand
 * pen, text notes, signature stamps) are staged as overlay items and
 * composited into the PDF with pdf-lib on save — all client-side,
 * because Stirling's interactive tools (highlight/pen/sign-draw) have
 * no API surface; they live inside its own frontend. Save overwrites
 * the file in place (server keeps versions).
 */

type OverlayItem =
  | { type: 'highlight'; page: number; x: number; y: number; w: number; h: number }
  | { type: 'pen'; page: number; points: Array<{ x: number; y: number }> }
  | { type: 'note'; page: number; x: number; y: number; text: string }
  | { type: 'signature'; page: number; x: number; y: number; w: number; h: number; dataUrl: string }

export default defineComponent({
  name: 'StirlingPdfCanvasEditor',
  props: {
    resource: {
      type: Object as PropType<Resource>,
      required: true
    },
    space: {
      type: Object as PropType<SpaceResource>,
      required: false,
      default: undefined
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

    const clientService = useClientService()
    const resourcesStore = useResourcesStore()
    const { showErrorMessage, showMessage } = useMessages()

    const loading = ref(true)
    const saving = ref(false)
    const error = ref('')
    const pageCount = ref(0)
    const pageNum = ref(1)
    const tool = ref<'select' | 'highlight' | 'pen' | 'note' | 'signature'>('highlight')
    const items = ref<OverlayItem[]>([])
    const signing = ref(false)
    const signatureDataUrl = ref('')

    const baseCanvas = ref<HTMLCanvasElement>()
    const overlayCanvas = ref<HTMLCanvasElement>()
    const signatureCanvas = ref<HTMLCanvasElement>()

    const displayWidth = 900
    let pdfScale = 1
    let pdfjsDoc: { numPages: number; getPage: (n: number) => Promise<any> } | null = null
    let pdfLibDoc: PDFDocument | null = null
    let pageHeightPts = 792

    const tools = computed(() => [
      { id: 'highlight' as const, label: $gettext('Highlight') },
      { id: 'pen' as const, label: $gettext('Pen') },
      { id: 'note' as const, label: $gettext('Note') },
      { id: 'signature' as const, label: $gettext('Signature') }
    ])

    const hint = computed(() => {
      switch (tool.value) {
        case 'highlight':
          return $gettext('Drag a rectangle over the text to highlight.')
        case 'pen':
          return $gettext('Draw directly on the page.')
        case 'note':
          return $gettext('Click where the note should sit.')
        case 'signature':
          return signatureDataUrl.value
            ? $gettext('Click to stamp the signature.')
            : $gettext('Click to draw and place a signature.')
        default:
          return ''
      }
    })

    const toPdfCoords = (cssX: number, cssY: number) => ({
      x: cssX / pdfScale,
      y: pageHeightPts - cssY / pdfScale
    })

    const drawOverlay = () => {
      const canvas = overlayCanvas.value
      if (!canvas) return
      const ctx = canvas.getContext('2d')
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      for (const item of items.value.filter((i) => i.page === pageNum.value)) {
        if (item.type === 'highlight') {
          ctx.fillStyle = 'rgba(255,235,59,0.4)'
          ctx.fillRect(
            item.x * pdfScale,
            (pageHeightPts - item.y - item.h) * pdfScale,
            item.w * pdfScale,
            item.h * pdfScale
          )
        } else if (item.type === 'pen') {
          ctx.strokeStyle = '#d32f2f'
          ctx.lineWidth = 2
          ctx.beginPath()
          item.points.forEach((p, i) => {
            const cx = p.x * pdfScale
            const cy = (pageHeightPts - p.y) * pdfScale
            i === 0 ? ctx.moveTo(cx, cy) : ctx.lineTo(cx, cy)
          })
          ctx.stroke()
        } else if (item.type === 'note') {
          const cx = item.x * pdfScale
          const cy = (pageHeightPts - item.y) * pdfScale
          ctx.fillStyle = 'rgba(255,213,79,0.9)'
          ctx.fillRect(cx, cy - 18, 18, 18)
          ctx.fillStyle = '#000'
          ctx.font = '12px sans-serif'
          ctx.fillText('i', cx + 6, cy - 5)
        } else if (item.type === 'signature') {
          const img = new Image()
          img.src = item.dataUrl
          if (img.complete) {
            ctx.drawImage(
              img,
              item.x * pdfScale,
              (pageHeightPts - item.y - item.h) * pdfScale,
              item.w * pdfScale,
              item.h * pdfScale
            )
          } else {
            img.onload = () => drawOverlay()
          }
        }
      }
    }

    const showPage = async (n: number) => {
      pageNum.value = Math.min(Math.max(1, n), pageCount.value)
      const page = await pdfjsDoc.getPage(pageNum.value)
      const base = page.getViewport({ scale: 1 })
      pageHeightPts = base.view[3]
      pdfScale = displayWidth / base.view[2]
      const viewport = page.getViewport({ scale: pdfScale })
      for (const c of [baseCanvas.value, overlayCanvas.value]) {
        c.width = viewport.width
        c.height = viewport.height
      }
      await page.render({ canvasContext: baseCanvas.value.getContext('2d'), viewport }).promise
      drawOverlay()
    }

    // live drawing state
    let dragging = false
    let dragStart = { x: 0, y: 0 }
    let dragCurrent = { x: 0, y: 0 }
    let penPoints: Array<{ x: number; y: number }> = []

    const canvasPos = (event: PointerEvent) => {
      const rect = overlayCanvas.value.getBoundingClientRect()
      return { x: event.clientX - rect.left, y: event.clientY - rect.top }
    }

    const onPointerDown = (event: PointerEvent) => {
      if (tool.value === 'signature') {
        if (!signatureDataUrl.value) {
          openSignaturePad()
          return
        }
        const pos = canvasPos(event)
        const pdf = toPdfCoords(pos.x, pos.y)
        items.value.push({
          type: 'signature',
          page: pageNum.value,
          x: pdf.x,
          y: pdf.y - 60,
          w: 180,
          h: 60,
          dataUrl: signatureDataUrl.value
        })
        drawOverlay()
        return
      }
      if (tool.value === 'note') {
        const text = window.prompt($gettext('Note text'))
        if (text) {
          const pdf = toPdfCoords(canvasPos(event).x, canvasPos(event).y)
          items.value.push({ type: 'note', page: pageNum.value, x: pdf.x, y: pdf.y, text })
          drawOverlay()
        }
        return
      }
      dragging = true
      overlayCanvas.value.setPointerCapture(event.pointerId)
      dragStart = dragCurrent = canvasPos(event)
      penPoints = []
      if (tool.value === 'pen') {
        penPoints.push(toPdfCoords(dragStart.x, dragStart.y))
      }
    }

    const onPointerMove = (event: PointerEvent) => {
      if (!dragging) return
      dragCurrent = canvasPos(event)
      if (tool.value === 'pen') {
        penPoints.push(toPdfCoords(dragCurrent.x, dragCurrent.y))
        drawOverlay()
        // live segment
        const ctx = overlayCanvas.value.getContext('2d')
        ctx.strokeStyle = '#d32f2f'
        ctx.lineWidth = 2
        ctx.beginPath()
        const prev = penPoints[penPoints.length - 2]
        if (prev) {
          ctx.moveTo(prev.x * pdfScale, (pageHeightPts - prev.y) * pdfScale)
          ctx.lineTo(dragCurrent.x, dragCurrent.y)
          ctx.stroke()
        }
      }
    }

    const onPointerUp = () => {
      if (!dragging) return
      dragging = false
      if (tool.value === 'pen' && penPoints.length > 1) {
        items.value.push({ type: 'pen', page: pageNum.value, points: [...penPoints] })
      } else if (tool.value === 'highlight') {
        const a = toPdfCoords(
          Math.min(dragStart.x, dragCurrent.x),
          Math.max(dragStart.y, dragCurrent.y)
        )
        const b = toPdfCoords(
          Math.max(dragStart.x, dragCurrent.x),
          Math.min(dragStart.y, dragCurrent.y)
        )
        if (Math.abs(b.x - a.x) > 2 && Math.abs(a.y - b.y) > 2) {
          items.value.push({
            type: 'highlight',
            page: pageNum.value,
            x: a.x,
            y: b.y,
            w: b.x - a.x,
            h: a.y - b.y
          })
        }
      }
      drawOverlay()
    }

    const openSignaturePad = () => {
      signing.value = true
      void nextTick(() => {
        const ctx = signatureCanvas.value.getContext('2d')
        ctx.clearRect(0, 0, 500, 200)
        ctx.lineWidth = 3
        ctx.lineCap = 'round'
        ctx.strokeStyle = '#000'
      })
    }

    let signDrawing = false
    const signPos = (event: PointerEvent) => {
      const rect = signatureCanvas.value.getBoundingClientRect()
      return {
        x: ((event.clientX - rect.left) / rect.width) * 500,
        y: ((event.clientY - rect.top) / rect.height) * 200
      }
    }
    const onSignDown = (event: PointerEvent) => {
      signDrawing = true
      signatureCanvas.value.setPointerCapture(event.pointerId)
      const ctx = signatureCanvas.value.getContext('2d')
      const p = signPos(event)
      ctx.beginPath()
      ctx.moveTo(p.x, p.y)
    }
    const onSignMove = (event: PointerEvent) => {
      if (!signDrawing) return
      const ctx = signatureCanvas.value.getContext('2d')
      const p = signPos(event)
      ctx.lineTo(p.x, p.y)
      ctx.stroke()
    }
    const onSignUp = () => {
      signDrawing = false
    }
    const clearSignature = () => {
      signatureCanvas.value.getContext('2d').clearRect(0, 0, 500, 200)
    }
    const acceptSignature = () => {
      signatureDataUrl.value = signatureCanvas.value.toDataURL('image/png')
      signing.value = false
      tool.value = 'signature'
    }

    const load = async () => {
      loading.value = true
      error.value = ''
      try {
        if (!props.space) {
          throw new Error('no space provided by the editor route')
        }
        const { response } = await clientService.webdav.getFileContents(
          props.space,
          { path: props.resource.path },
          { responseType: 'blob' }
        )
        const bytes = new Uint8Array(await (response.data as Blob).arrayBuffer())

        const pdfjs = await import('pdfjs-dist')
        pdfjsDoc = await pdfjs.getDocument({ data: bytes.slice() }).promise
        pageCount.value = pdfjsDoc.numPages

        pdfLibDoc = await PDFDocument.load(bytes, { ignoreEncryption: true })
        await showPage(1)
      } catch (e) {
        error.value = e instanceof Error ? e.message : String(e)
        showErrorMessage({
          title: $gettext('Failed to open the document'),
          errors: [e instanceof Error ? e : new Error(String(e))]
        })
      } finally {
        loading.value = false
      }
    }

    const save = async () => {
      saving.value = true
      error.value = ''
      try {
        if (!pdfLibDoc) {
          throw new Error('document not loaded')
        }
        const pages = pdfLibDoc.getPages()
        const yellow = rgb(1, 0.92, 0.23)
        const red = rgb(0.83, 0.18, 0.18)
        for (const item of items.value) {
          const page = pages[item.page - 1]
          if (!page) continue
          if (item.type === 'highlight') {
            page.drawRectangle({
              x: item.x,
              y: item.y,
              width: item.w,
              height: item.h,
              color: yellow,
              opacity: 0.4
            })
          } else if (item.type === 'pen') {
            for (let i = 1; i < item.points.length; i++) {
              page.drawLine({
                start: item.points[i - 1],
                end: item.points[i],
                thickness: 2 / pdfScale,
                color: red
              })
            }
          } else if (item.type === 'note') {
            page.drawRectangle({
              x: item.x,
              y: item.y - 14,
              width: 14,
              height: 14,
              color: yellow,
              opacity: 0.9
            })
            page.drawText('i', { x: item.x + 5, y: item.y - 11, size: 10 })
          } else if (item.type === 'signature') {
            const dataUrl = item.dataUrl
            const base64 = dataUrl.split(',')[1]
            const pngBytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
            const image = await pdfLibDoc.embedPng(pngBytes)
            page.drawImage(image, { x: item.x, y: item.y, width: item.w, height: item.h })
          }
        }
        const saved = await pdfLibDoc.save()
        const updated = await clientService.webdav.putFileContents(props.space, {
          path: props.resource.path,
          content: saved.buffer as ArrayBuffer,
          overwrite: true
        })
        const storeResource = resourcesStore.resources.find((r) => r.id === props.resource.id)
        if (storeResource) {
          storeResource.size = updated.size
          storeResource.etag = updated.etag
        }
        showMessage({ title: $gettext('"%{name}" saved', { name: props.resource.name }) })
        items.value = []
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

    onMounted(load)

    return {
      loading,
      saving,
      error,
      hint,
      pageCount,
      pageNum,
      tool,
      tools,
      items,
      signing,
      baseCanvas,
      overlayCanvas,
      signatureCanvas,
      showPage,
      save,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onSignDown,
      onSignMove,
      onSignUp,
      clearSignature,
      acceptSignature
    }
  }
})
</script>

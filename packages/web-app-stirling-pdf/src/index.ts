import { useGettext } from 'vue3-gettext'
import translations from '../l10n/translations.json'
import { defineWebApplication } from '@opencloud-eu/web-pkg'
import { useExtensions } from './composables/useExtensions'

// CanvasEditor.vue stays in the tree (unbuilt — nothing imports it) for
// a future revival of the Open With target; disabled 2026-11-03 as too
// janky. Context actions remain the Stirling surface.

const applicationId = 'stirling-pdf'

export default defineWebApplication({
  setup(args) {
    const { $gettext } = useGettext()
    const extensions = useExtensions(args)

    return {
      appInfo: {
        name: $gettext('Stirling PDF'),
        id: applicationId,
        icon: 'file-pdf-2'
      },
      translations,
      extensions
    }
  }
})

import { useGettext } from 'vue3-gettext'
import translations from '../l10n/translations.json'
import { AppWrapperRoute, defineWebApplication } from '@opencloud-eu/web-pkg'
import { useExtensions } from './composables/useExtensions'
import CanvasEditor from './CanvasEditor.vue'

const applicationId = 'stirling-pdf'

export default defineWebApplication({
  setup(args) {
    const { $gettext } = useGettext()
    const extensions = useExtensions(args)

    return {
      appInfo: {
        name: $gettext('Stirling PDF'),
        id: applicationId,
        icon: 'file-pdf-2',
        // Canvas editor (CanvasEditor.vue): pdf.js render + pdf-lib
        // compositing for highlight/pen/note/signature. All client-side
        // — Stirling's interactive tools have no API surface. A real
        // Open With target.
        defaultExtension: 'pdf',
        extensions: [
          {
            extension: 'pdf',
            routeName: 'stirling-pdf-editor'
          }
        ]
      },
      routes: [
        {
          name: 'stirling-pdf-editor',
          path: '/:driveAliasAndItem(.*)?',
          component: AppWrapperRoute(CanvasEditor, {
            applicationId,
            // MUST return null: a truthy extension triggers the
            // wrapper's import-copy flow (file copied to
            // name_TIMESTAMP.<ext> on every open — duplicate files +
            // "Could not overwrite Resource" when it collides). We edit
            // the original in place.
            importResourceWithExtension() {
              return null
            }
          }),
          meta: {
            authContext: 'hybrid',
            patchCleanPath: true
          }
        }
      ],
      translations,
      extensions
    }
  }
})

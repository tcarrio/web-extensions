import { useGettext } from 'vue3-gettext'
import translations from '../l10n/translations.json'
import { AppWrapperRoute, defineWebApplication } from '@opencloud-eu/web-pkg'
import { useExtensions } from './composables/useExtensions'
import Editor from './Editor.vue'

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
        // Interactive text editor (Editor.vue) on Stirling's
        // text-editor session API — a real Open With target, unlike the
        // 0.2.0 operation launcher (removed in 0.3.0).
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
          component: AppWrapperRoute(Editor, {
            applicationId,
            importResourceWithExtension() {
              return 'pdf'
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

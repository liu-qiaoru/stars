import { LibraryWorkspace } from '../../components/library-workspace'
import { demoLibraries } from '../../lib/demo-data'

export default function LibrariesPage() {
  return <LibraryWorkspace libraries={demoLibraries} />
}

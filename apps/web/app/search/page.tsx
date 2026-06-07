import { SearchWorkspace } from '../../components/search-workspace'
import { demoLibraries, demoSearchResponse } from '../../lib/demo-data'

export default function SearchPage() {
  return (
    <SearchWorkspace
      libraries={demoLibraries}
      initialQuery="发布会"
      initialResults={demoSearchResponse}
    />
  )
}

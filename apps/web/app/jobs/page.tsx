import { JobsWorkspace } from '../../components/jobs-workspace'
import { demoJobs } from '../../lib/demo-data'

export default function JobsPage() {
  return <JobsWorkspace jobs={demoJobs} />
}

import { Route, Routes, Navigate } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/overlays'
import { AppShell } from '@/components/layout/AppShell'
import { Workbench } from '@/pages/Workbench'
import { ProjectsPage } from '@/pages/ProjectsPage'
import { ProjectPage } from '@/pages/ProjectPage'
import { SettingsPage } from '@/pages/SettingsPage'

export default function App() {
  return (
    <TooltipProvider delayDuration={250} skipDelayDuration={120}>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<Workbench />} />
          <Route path="projects" element={<ProjectsPage />} />
          <Route path="project/:id" element={<ProjectPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </TooltipProvider>
  )
}

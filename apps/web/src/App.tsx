import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Navigate, Route, BrowserRouter as Router, Routes } from 'react-router-dom';
import { Layout } from './components/Layout.js';
import { ApprovalsPage } from './pages/ApprovalsPage.js';
import { AuditPage } from './pages/AuditPage.js';
import { ChatPage } from './pages/ChatPage.js';
import { DebriefPage } from './pages/DebriefPage.js';
import { DigestsPage } from './pages/DigestsPage.js';
import { FilesPage } from './pages/FilesPage.js';
import { MemoryPage } from './pages/MemoryPage.js';
import { SearchPage } from './pages/SearchPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { SourcesPage } from './pages/SourcesPage.js';
import { TasksPage } from './pages/TasksPage.js';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false },
  },
});

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Router>
        <Layout>
          <Routes>
            <Route path="/" element={<ChatPage />} />
            <Route path="/c/:conversationId" element={<ChatPage />} />
            <Route path="/debrief" element={<DebriefPage />} />
            <Route path="/digests" element={<DigestsPage />} />
            <Route path="/digests/:digestId" element={<DebriefPage />} />
            <Route path="/tasks" element={<TasksPage />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/sources" element={<SourcesPage />} />
            <Route path="/files" element={<FilesPage />} />
            <Route path="/approvals" element={<ApprovalsPage />} />
            <Route path="/memory" element={<MemoryPage />} />
            <Route path="/audit" element={<AuditPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/settings/:tab" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Layout>
      </Router>
    </QueryClientProvider>
  );
}

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { AboutPage } from './pages/About';
import { DocPage } from './pages/Doc';
import { HomePage } from './pages/Home';
import { VerifyPage } from './pages/Verify';
import { WatchersPage } from './pages/Watchers';

const client = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 15_000, retry: 1, refetchOnWindowFocus: false },
  },
});

export function App(): React.ReactElement {
  return (
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<HomePage />} />
            <Route path="docs/:docId" element={<DocPage />} />
            <Route path="verify" element={<VerifyPage />} />
            <Route path="watchers" element={<WatchersPage />} />
            <Route path="about" element={<AboutPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

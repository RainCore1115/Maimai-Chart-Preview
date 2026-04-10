import { Navigate, Route, Routes } from 'react-router-dom';
import PreviewPage from './PreviewPage';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<PreviewPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

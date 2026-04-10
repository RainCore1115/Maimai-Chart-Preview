import { Navigate, Route, Routes, useSearchParams } from 'react-router-dom';
import HomePage from './pages/HomePage';
import PreviewPage from './PreviewPage';

/** 兼容此前挂载在 `/` 的谱面查询参数分享链接 */
function HomeOrPreviewRedirect() {
  const [searchParams] = useSearchParams();
  if (searchParams.has('song')) {
    return <Navigate to={{ pathname: '/preview', search: searchParams.toString() }} replace />;
  }
  return <HomePage />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<HomeOrPreviewRedirect />} />
      <Route path="/preview" element={<PreviewPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

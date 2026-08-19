import axios from "axios";
import { message } from "antd";

const defaultApiHost = `${window.location.protocol}//${window.location.hostname}:8002`;
// Раздел про ускорение первой загрузки на планшетах (быстрый режим) — все
// пути бэкенда живут под /api (backend/app/main.py, API_PREFIX), не
// делят "плоское" пространство путей с фронтендом на одном порту: без
// этого разделения /production-tasks (и ещё 8 таких же имён) совпадали
// один-в-один у SPA-раздела и у реального API-эндпоинта, и обычная
// навигация браузера (без Authorization-заголовка) попадала не в SPA, а
// в API и 401-ила. VITE_API_URL, если задан, — это ХОСТ без /api, сам
// префикс добавляется здесь же, одним местом для всего клиента.
const apiHost = import.meta.env.VITE_API_URL || defaultApiHost;

export const apiClient = axios.create({
  baseURL: `${apiHost}/api`,
});

apiClient.interceptors.request.use((config) => {
  const token = localStorage.getItem("access_token");
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Ключ в sessionStorage, куда Login.tsx смотрит после входа, чтобы вернуть
// пользователя туда, откуда его выкинуло (9.4 раздел бэклога доработок) —
// раньше повторный вход всегда вёл на "/", теряя контекст (например,
// середину сессии приёмки на партию из 9 рулонов).
export const POST_LOGIN_REDIRECT_KEY = "post_login_redirect";

apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      const wasLoggedIn = !!localStorage.getItem("access_token");
      localStorage.removeItem("access_token");
      if (window.location.pathname !== "/login") {
        if (wasLoggedIn) {
          message.warning("Сессия истекла — войдите снова");
          sessionStorage.setItem(POST_LOGIN_REDIRECT_KEY, window.location.pathname + window.location.search);
        }
        window.location.assign("/login");
      }
    }
    return Promise.reject(error);
  },
);

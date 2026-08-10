import axios from "axios";
import { message } from "antd";

export const apiClient = axios.create({
  baseURL: import.meta.env.VITE_API_URL ?? "http://localhost:8000",
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

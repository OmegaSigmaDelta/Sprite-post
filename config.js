// Настройки сайта. Меняйте только текст в кавычках.
// Руководство: GUIDE.html, шаг 4.
export const CONFIG = {
  // Адрес проекта Supabase. Выглядит так: https://abcdefghij.supabase.co
  SUPABASE_URL: "https://xtgenimsvxmmvxetqner.supabase.co",

  // Публичный ключ: "Publishable key" (начинается с sb_publishable_) или "anon public".
  // Его безопасно хранить в этом файле. Ключи "secret" и "service_role" сюда НЕЛЬЗЯ.
  SUPABASE_KEY: "sb_publishable_tT2kPQ0M2ULW3jn6aInb2g_lo5wIztz",

  // Репозиторий игры по умолчанию (можно поменять и в самом приложении).
  DEFAULT_REPO: "OmegaSigmaDelta/Sierra-Tango-Kasper-Echo",

  // Лимиты, чтобы не выйти за бесплатный тариф Supabase (1 ГБ файлов).
  STORAGE_LIMIT_MB: 900,   // загрузки блокируются, когда набрано столько
  MAX_FILE_MB: 30,         // максимальный размер одного файла
  THUMB_MAX_MB: 3,         // картинки крупнее не подгружаются сами, только по кнопке

  // Прочее.
  MESSAGES_PAGE: 100,          // сколько сообщений грузить за раз
  RELEASE_SYNC_MINUTES: 15     // как часто открытая страница разработчика сверяет релизы с GitHub
};

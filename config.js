/* CONFIGURACIÓN DE LA WEB
 *
 * Lo único obligatorio es apiUrl. El resto de ajustes (nombre, colores, logo, WhatsApp, idioma
 * y umbrales del semáforo) se pueden cambiar sin tocar este archivo desde la hoja "Config"
 * del Google Sheet. Los valores de abajo se usan mientras la web carga o si el Sheet no los define.
 */
window.APP_CONFIG = {
  // Dirección de tu Apps Script (termina en /exec). Si lo dejas vacío, la web funciona en MODO DEMO.
  apiUrl: "https://script.google.com/macros/s/AKfycbyOXmyjzXBHDdg54Vjnp4NrKGqhj9NFZPTu-qz3KNND2rjiRK8aph-JM957wShfJCn20g/exec",

  // Tu WhatsApp con código de país, sin + ni espacios.
  whatsapp: "584143539523",

  // "es" para español, "en" para inglés.
  language: "es",

  // Carpeta donde subes los videos y el logo.
  mediaBase: "media/",

  // Marca por defecto.
  brand: {
    name: "Fisio Tendón",
    tagline: "Seguimiento y readaptación",
    logo: "",              // por ejemplo "logo.png" (archivo dentro de media/)
    primary: "#0F6B63",    // color de la marca en modo claro
    primaryDark: "#4FD1C0" // color de la marca en modo oscuro
  }
};

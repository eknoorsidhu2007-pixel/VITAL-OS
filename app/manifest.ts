import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "VITAL OS",
    short_name: "VITAL OS",
    description:
      "Clinical voice operating system for ambient chart retrieval and documentation.",
    start_url: "/",
    display: "standalone",
    background_color: "#f7fbff",
    theme_color: "#0B2A55",
    icons: [
      {
        src: "/vital-logo.png",
        sizes: "192x192",
        type: "image/png",
      },
      {
        src: "/vital-logo.png",
        sizes: "512x512",
        type: "image/png",
      },
    ],
  };
}

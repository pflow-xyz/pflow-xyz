const shareButtonAllowedHostnames = [
    'pflow.dev',
    'pflow.xyz',
    `localhost`,
    `127.0.0.1`
];

export function supportsShareButton() {
    return shareButtonAllowedHostnames.includes(window.location.hostname)
}

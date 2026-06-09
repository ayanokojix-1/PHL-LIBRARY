function extractDriveId(url) {
    const match = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
    return match ? match[1] : null;
}

// /preview works for public files with no Google account required
function gdrivePreviewUrl(url) {
    const id = extractDriveId(url);
    return id ? `https://drive.google.com/file/d/${id}/preview` : url;
}

function gdriveDownloadUrl(url) {
    const id = extractDriveId(url);
    return id ? `https://drive.google.com/uc?export=download&id=${id}` : url;
}

module.exports = { gdrivePreviewUrl, gdriveDownloadUrl };

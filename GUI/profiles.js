(() => {
    const profiles = {
        balanced: { name: '均衡', description: '沿用原有低延迟编码设置。' },
        office: { name: '办公', description: '使用 NVENC P2 和较大的码控缓冲，适合评估文字和静态画面。' },
        dynamic: { name: '动态', description: '使用单帧大小的码控缓冲，适合评估滚动和高速运动。' }
    };
    if (typeof module === 'object' && module.exports) module.exports = profiles;
    else globalThis.ReDisplayProfiles = profiles;
})();

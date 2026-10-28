// Keep camera buffers bounded instead of launching the phone's full-resolution photo app.
export class Camera {
  constructor(video, mediaDevices = globalThis.navigator?.mediaDevices) {
    this.video = video; this.mediaDevices = mediaDevices; this.generation = 0; this.stream = null;
  }
  async start() {
    this.stop(); const generation = this.generation;
    if (!this.mediaDevices?.getUserMedia) throw Error('Este navegador no permite abrir la cámara aquí. Podés elegir una foto de la galería o usar la cámara del teléfono.');
    let stream;
    try {
      stream = await this.mediaDevices.getUserMedia({audio:false,video:{
        facingMode:{ideal:'environment'},width:{ideal:1200,max:1280},height:{ideal:900,max:1280},frameRate:{ideal:15,max:15}
      }});
      // A permission request can resolve after Cancel, hiding the page, or another attempt.
      if (generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); return false; }
      this.stream = stream; this.video.srcObject = stream;
      await this.video.play();
      return generation === this.generation;
    } catch (error) {
      if (generation !== this.generation) return false;
      this.stop(); throw error;
    }
  }
  stop() {
    this.generation++;
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = null;
    this.video.pause(); this.video.srcObject = null;
  }
}

export function cameraError(error) {
  if (error.name === 'NotAllowedError' || error.name === 'SecurityError') return 'No se habilitó la cámara. Permití su uso en el navegador o elegí una foto de la galería.';
  if (error.name === 'NotFoundError') return 'No se encontró una cámara. Podés elegir una foto de la galería.';
  if (['NotReadableError','AbortError','OverconstrainedError'].includes(error.name)) return 'No se pudo iniciar la cámara. Cerrá otras apps que la usen y reintentá, o elegí una foto de la galería.';
  return error.message || 'No se pudo abrir la cámara. Podés elegir una foto de la galería.';
}

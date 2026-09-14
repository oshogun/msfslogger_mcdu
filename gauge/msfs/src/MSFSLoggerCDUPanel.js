(function () {
  class MSFSLoggerCDUPanel extends TemplateElement {
    connectedCallback() {
      super.connectedCallback();
      this.ui = this.querySelector('ingame-ui'); this.frame = this.querySelector('#MSFSLoggerCDUFrame');
      if (!this.ui || !this.frame) return;
      this.ui.addEventListener('panelActive', () => {
        if (!this.frame.getAttribute('src')) {
          this.frame.setAttribute('src', '/Pages/VCockpit/Instruments/MSFSLoggerCDU/MSFSLoggerCDU.html?v=0.1.1');
        } else if (this.frame.contentWindow && this.frame.contentWindow.msfsloggerGaugeHost) {
          this.frame.contentWindow.msfsloggerGaugeHost.resume();
        }
      });
      this.ui.addEventListener('panelInactive', () => { if (this.frame.contentWindow && this.frame.contentWindow.msfsloggerGaugeHost) this.frame.contentWindow.msfsloggerGaugeHost.suspend(); });
    }
  }
  window.customElements.define('msfslogger-cdu-panel', MSFSLoggerCDUPanel); checkAutoload();
}());

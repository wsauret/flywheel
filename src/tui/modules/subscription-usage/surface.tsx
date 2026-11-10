/** @jsxImportSource @opentui/solid */
import type { TuiControllerHost } from "../../tui-module.js"
import { UsageModal } from "./modal.js"
import { useUsageModal, type UsageModalView } from "./use-usage-modal.js"

export function createUsageSurface(host: TuiControllerHost, initialView: UsageModalView = "accounts"): () => void {
  const usageModal = useUsageModal({
    initialView,
    modal: host.modal,
    appService: host.client,
    foregroundId: host.foregroundId,
    effectiveProfileId: () => host.auth()?.profile.id,
    auth: host.auth,
    renderModal: () => (
      <UsageModal
        view={usageModal.usageView()}
        accounts={usageModal.usageAccounts()}
        spend={usageModal.usageSpend()}
        history={usageModal.usageHistory()}
        loading={usageModal.usageLoading()}
        failure={usageModal.usageFailure()}
        selectedSourceId={usageModal.selectedSourceId()}
        spendRange={usageModal.usageSpendRange()}
        historyRange={usageModal.usageHistoryRange()}
        showDetailMetrics={usageModal.usageShowDetailMetrics()}
        resetAttempt={usageModal.resetAttempt()}
        currentScroll={usageModal.currentScroll}
        spendScroll={usageModal.spendScroll}
        onClose={usageModal.closeUsageModal}
        onRefresh={usageModal.refreshUsage}
        onViewChange={usageModal.setUsageView}
        onSourceChange={usageModal.setSelectedSourceId}
        onSpendRangeChange={usageModal.setSpendRange}
        onHistoryRangeChange={usageModal.setHistoryRange}
        onBeginReset={usageModal.beginApplyReset}
        onConfirmReset={usageModal.confirmApplyReset}
        onCancelReset={usageModal.cancelApplyReset}
      />
    ),
  })
  return usageModal.openUsageModal
}

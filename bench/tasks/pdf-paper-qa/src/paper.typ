#set document(title: "TideFormer: Harmonic-Aware Sparse Attention for Multi-Horizon Coastal Water Level Forecasting", author: ("Lena Marsh", "Rafael Quintero", "Aiko Tanabe", "Pieter van Dalen"), date: none)
#set page(paper: "a4", margin: (x: 2.3cm, top: 2.6cm, bottom: 2.6cm), columns: 2, numbering: "1",
  header: context { if here().page() > 1 [#set text(size: 8pt, fill: luma(90)); _TideFormer: Harmonic-Aware Sparse Attention for Coastal Water Level Forecasting_ #h(1fr) Preprint] })
#set columns(gutter: 0.7cm)
#set text(font: "Libertinus Serif", size: 11pt, lang: "en")
#set par(justify: true, leading: 0.66em, spacing: 1.0em)
#set heading(numbering: "1.1")
#show heading.where(level: 1): it => block(above: 1.3em, below: 0.7em, text(size: 12pt, weight: "bold", it))
#show heading.where(level: 2): it => block(above: 1.0em, below: 0.6em, text(size: 10.5pt, weight: "bold", it))
#set math.equation(numbering: "(1)")
#show figure.where(kind: table): set figure.caption(position: top)
#show figure.caption: set text(size: 9pt)
#set table(stroke: none, inset: (x: 4pt, y: 2.6pt))
#show table: set text(size: 8.5pt)
#let tf = smallcaps[TideFormer]
#let hl(x) = text(weight: "bold", x)

#place(top + center, scope: "parent", float: true, {
  align(center, {
    v(0.3cm)
    text(size: 17pt, weight: "bold")[TideFormer: Harmonic-Aware Sparse Attention for\ Multi-Horizon Coastal Water Level Forecasting]
    v(0.4cm)
    text(size: 11pt)[Lena Marsh#super[1], Rafael Quintero#super[2], Aiko Tanabe#super[1], Pieter van Dalen#super[3]]
    v(0.15cm)
    text(size: 9pt)[#super[1]Coastal Systems Laboratory, University of Saltmere #h(0.6em) #super[2]Instituto de Oceanografía Aplicada, Puerto Calma \ #super[3]Delta Hydraulics Institute, Rijswaard]
    v(0.5cm)
  })
  block(width: 100%, inset: (x: 1.2cm), {
    set text(size: 9.5pt)
    set par(justify: true)
    align(center, text(weight: "bold")[Abstract])
    v(0.1cm)
    [Accurate forecasts of coastal water levels over horizons of a few hours to several days are needed for port operations, flood early warning and the scheduling of coastal works. Water levels combine a deterministic astronomical tide with a stochastic meteorological residual (the surge), and the two components interact in shallow water. Classical harmonic analysis predicts the tide very well but ignores the surge, while generic deep forecasting models learn both components from data but waste capacity rediscovering tidal periodicities and degrade at long horizons. We present #tf, a transformer for multi-horizon water level forecasting that (i) embeds time through a bank of learnable tidal constituents initialized at their astronomical frequencies, (ii) restricts attention to positions separated by multiples of the dominant tidal periods, and (iii) predicts the surge with a separate head conditioned on atmospheric forcing. On five public tide gauge collections with 186 stations, #tf reduces the mean absolute error at the 72-hour horizon by 14.6% on average relative to the strongest baseline on each dataset, while using fewer floating-point operations than a standard transformer of the same depth. An ablation study and a case study of a winter storm show that the harmonic embedding contributes most of the gain and that the surge head substantially reduces peak errors during storm events.]
    v(0.5cm)
  })
})

= Introduction

Coastal water levels are among the most consequential geophysical variables for human activity. Harbour masters schedule the movements of deep-draught vessels around high water, dredging and construction works in the intertidal zone are planned in tidal windows, and flood warning services issue alerts when the predicted total water level exceeds critical thresholds at protected coastlines. All of these applications require forecasts not only for the next hour but for horizons of one to three days, so that operational decisions can be taken in advance.

The observed water level at a tide gauge is conventionally decomposed into two parts. The astronomical tide is the response of the ocean to the gravitational forcing of the Moon and the Sun; it is a sum of sinusoidal constituents whose frequencies are known exactly from celestial mechanics and whose amplitudes and phases can be estimated from a year or more of observations by harmonic analysis [8, 19]. The residual, often called the non-tidal residual or surge, is caused by wind stress, atmospheric pressure, river discharge and a host of smaller effects. Whereas the tide is predictable decades ahead, the surge is driven by the weather and can only be forecast as far ahead as the weather itself.

Operational forecasting systems traditionally combine a harmonic tide prediction with a surge forecast from a hydrodynamic model forced by numerical weather predictions [12]. Such systems are accurate but expensive to set up and to maintain: each new station requires a calibrated hydrodynamic model domain, and many small harbours do not have access to one. Data-driven forecasting offers an attractive alternative because it can be trained directly on the gauge record and a few freely available atmospheric reanalysis variables.

Deep learning models for time series forecasting have advanced quickly. Recurrent networks such as the LSTM [14] were followed by transformer architectures that address the quadratic cost of attention over long input windows, including Informer [31] and Autoformer [27]. More recently, simple linear models [30] and patch-based transformers [22] have been shown to match or outperform more complex architectures on standard forecasting datasets. Applied to coastal water levels, however, these generic models face two difficulties. First, the tidal signal is dominated by a few dozen sharply defined frequencies, several of which are close to each other (for example the principal lunar semidiurnal constituent M#sub[2] with a period of 12.42 hours and the principal solar semidiurnal constituent S#sub[2] with a period of exactly 12 hours). Their beating produces the spring–neap cycle of about 14.8 days, which is longer than the input window of most forecasting models, so that the models must infer the phase of the cycle indirectly. Second, the error of generic models grows quickly with the forecast horizon, because the models have no mechanism that would allow them to extrapolate the tide beyond what they can infer from the input window.

In this paper we propose #tf, a transformer that incorporates the structure of the tide directly into its architecture while learning the surge and the shallow-water interactions from data. Our contributions are the following.

- We introduce a _harmonic time embedding_ consisting of a bank of tidal constituents whose frequencies are initialized at their astronomical values and fine-tuned during training, together with station-specific amplitudes and phases. The embedding gives the model access to the absolute tidal phase at any future time step.
- We propose _tidal sparse attention_, in which each query attends only to keys at lags that are close to integer multiples of the dominant tidal periods. This reduces the cost of attention from quadratic to linear in the window length and acts as a strong inductive bias.
- We add a _surge head_ that predicts the non-tidal residual from atmospheric forcing and a learned summary of the recent residual, and we train the model with an objective that includes a phase-consistency term.
- We evaluate #tf on five public collections of tide gauge records covering semidiurnal, mixed and microtidal regimes, and we provide an ablation study, an efficiency comparison and a case study of a severe winter storm.

The remainder of the paper is organized as follows. @sec:related reviews related work, @sec:problem formalizes the forecasting problem, @sec:background summarizes the relevant tidal background, and @sec:method describes #tf. The experimental setup is described in @sec:setup and the results in @sec:results. @sec:discussion discusses limitations, and @sec:conclusion concludes.

= Related work <sec:related>

*Harmonic analysis and operational systems.* The harmonic method of tidal prediction dates back to Kelvin and Darwin and remains the standard for tide tables. Modern implementations such as T\_TIDE [24] and UTide [8] estimate the amplitudes and phases of up to several dozen constituents by least squares, including nodal corrections for the 18.6-year lunar cycle. Harmonic predictions are excellent in open-coast settings but deteriorate in estuaries and shallow seas, where nonlinear interactions generate overtides and where the tide interacts with river discharge and surge [13]. Operational surge forecasting relies on depth-averaged hydrodynamic models forced by numerical weather prediction, often run as ensembles [12, 20].

*Machine learning for water levels.* Early data-driven approaches used multilayer perceptrons to forecast the surge residual at individual stations [7], followed by recurrent networks [3, 16] and convolutional models [18]. These studies typically train one model per station and predict only the residual, relying on harmonic analysis for the tide. Bruneau et al. [4] trained a global model on hundreds of gauges to estimate extreme surges, and Tiggeloven et al. [26] compared several deep architectures for surge prediction at the global scale. Hybrid physics–machine learning models have been proposed that correct the output of hydrodynamic models with neural networks [17]. To the best of our knowledge, no previous work has incorporated tidal harmonics into the architecture of an attention-based model for total water level forecasting.

*Transformers for time series.* The original transformer [25] has been adapted to long sequence forecasting in several ways. Informer [31] selects a subset of dominant queries through a sparsity measurement, Autoformer [27] replaces attention with an auto-correlation mechanism that aggregates sub-series at the dominant periods, and FEDformer [32] operates in the frequency domain. Zeng et al. [30] showed that a simple linear model on decomposed series (DLinear) is competitive with these architectures, and PatchTST [22] restored the advantage of transformers by operating on patches of the input series with channel independence. Our tidal sparse attention is related to the auto-correlation mechanism of Autoformer, but the lags are fixed by tidal physics rather than estimated from the data, which makes the mechanism stable when the input window is shorter than the longest tidal period.

*Periodic and Fourier embeddings.* Learnable Fourier features have been used for positional encoding [15] and for representing time in event sequences [28]. Time2Vec [15] learns a set of frequencies from random initialization. In contrast, we initialize the frequencies at the astronomical values of the tidal constituents, which are known to a precision far beyond what can be learned from a few years of data, and we found that allowing only small deviations from these values is essential for good long-horizon performance.

= Problem formulation <sec:problem>

Consider a tide gauge station $s$ with a water level record $y_(s,t)$ sampled at hourly intervals $t = 1, 2, dots$, together with a vector of exogenous covariates $bold(x)_(s,t) in RR^d$. In our experiments the covariates are the mean sea-level pressure and the two components of the 10-metre wind at the nearest grid point of an atmospheric reanalysis, together with their values at four surrounding grid points, giving $d = 15$. At forecast time $t_0$ the model observes the context window $bold(y)_(s, t_0 - L + 1 : t_0)$ of length $L$ and the covariates over the context window and the forecast horizon, and predicts the water levels $hat(y)_(s, t_0 + h)$ for $h = 1, dots, H$.

Using the covariates over the forecast horizon corresponds to a perfect-prognosis setting in which the meteorological forecast is assumed to be exact. This is the standard protocol in the surge forecasting literature [4, 26] because it isolates the error of the water level model from that of the weather forecast. We additionally report results with degraded covariates in @sec:robustness.

The water level is decomposed as
$ y_(s,t) = eta_(s,t) + r_(s,t) + epsilon_(s,t), $ <eq:decomp>
where $eta_(s,t)$ is the astronomical tide, $r_(s,t)$ is the non-tidal residual and $epsilon_(s,t)$ is measurement noise. The decomposition is not observed directly: harmonic analysis yields an estimate of $eta$, but in shallow water the tide and the residual interact and the separation is ambiguous. #tf therefore predicts the total water level, and the decomposition is used only as a structural prior.

= Background: tidal constituents <sec:background>

The astronomical tide at a fixed location can be written as a sum of harmonic constituents,
$ eta(t) = Z_0 + sum_(k) f_k H_k cos(omega_k t + V_k + u_k - g_k), $ <eq:tide>
where $Z_0$ is the mean level, $H_k$ and $g_k$ are the amplitude and the phase lag of constituent $k$, $omega_k$ is its angular frequency, $V_k$ is the astronomical argument at a reference time, and $f_k$ and $u_k$ are nodal corrections that account for the 18.6-year cycle of the lunar orbit [19, 20]. The frequencies $omega_k$ are linear combinations of six fundamental astronomical frequencies and are known to a precision of better than $10^(-9)$ cycles per hour. The amplitudes and phases depend on the local hydrography and must be estimated from observations.

The constituents relevant to this work are listed in @tab:constituents. In the open ocean, a small number of semidiurnal and diurnal constituents dominate. In shallow water, the propagation speed of the tidal wave depends on the water depth, so that the crest travels faster than the trough. This asymmetry is represented by shallow-water constituents such as M#sub[4] and MS#sub[4], whose frequencies are sums of the frequencies of the primary constituents. In estuaries, the interaction of the tide with river discharge additionally modulates the amplitudes and phases of the constituents on the time scale of the discharge variations, which cannot be represented by a harmonic model with constant coefficients [13].

#figure(
  table(
    columns: (auto, 1fr, auto, auto),
    align: (left, left, right, left),
    table.hline(stroke: 0.8pt),
    table.header([*Symbol*], [*Name*], [*Period (h)*], [*Species*]),
    table.hline(stroke: 0.5pt),
    [M#sub[2]], [Principal lunar semidiurnal], [12.42], [semidiurnal],
    [S#sub[2]], [Principal solar semidiurnal], [12.00], [semidiurnal],
    [N#sub[2]], [Larger lunar elliptic], [12.66], [semidiurnal],
    [K#sub[2]], [Lunisolar semidiurnal], [11.97], [semidiurnal],
    [K#sub[1]], [Lunisolar diurnal], [23.93], [diurnal],
    [O#sub[1]], [Principal lunar diurnal], [25.82], [diurnal],
    [P#sub[1]], [Principal solar diurnal], [24.07], [diurnal],
    [Q#sub[1]], [Larger lunar elliptic diurnal], [26.87], [diurnal],
    [M#sub[4]], [Shallow-water overtide of M#sub[2]], [6.21], [quarter-diurnal],
    [MS#sub[4]], [Shallow-water compound], [6.10], [quarter-diurnal],
    [MN#sub[4]], [Shallow-water compound], [6.27], [quarter-diurnal],
    [Mf], [Lunisolar fortnightly], [327.86], [long-period],
    [Mm], [Lunar monthly], [661.31], [long-period],
    table.hline(stroke: 0.8pt),
  ),
  caption: [Tidal constituents used in the harmonic embedding of #tf.],
) <tab:constituents>

Harmonic analysis estimates $H_k$ and $g_k$ by least squares from a record that is long enough to separate the constituents. By the Rayleigh criterion, two constituents with frequencies $omega_k$ and $omega_l$ can be separated if the record length exceeds $2 pi \/ |omega_k - omega_l|$; separating S#sub[2] from K#sub[2], for example, requires about half a year of data. This is why harmonic analysis is normally performed on records of one year or longer, and why a forecasting model with an input window of a few days cannot separate these constituents from the data in its window alone.

= Method <sec:method>

An overview of #tf is shown in @fig:arch. The model consists of four components: an input encoder that maps the context window to a sequence of patch tokens, a harmonic time embedding that provides the tidal phase at every past and future time step, a stack of encoder blocks with tidal sparse attention, and two output heads for the tidal and the residual component of the forecast.

#figure(
  {
    set text(size: 7.5pt)
    let bx(body, fill: rgb("#edf2f7")) = box(width: 100%, inset: 4pt, radius: 2pt, fill: fill, stroke: 0.5pt, align(center, body))
    let arrow = align(center, text(size: 9pt)[$arrow.b$])
    grid(columns: (1fr, 0.25cm, 1fr), row-gutter: 3pt,
      bx[Context window $bold(y)_(t_0-L+1:t_0)$], [], bx[Calendar time $t$],
      arrow, [], arrow,
      bx[Patch embedding ($P = 12$)], [], bx(fill: rgb("#fefcbf"))[Harmonic embedding \ ($K$ constituents)],
      grid.cell(colspan: 3, arrow),
      grid.cell(colspan: 3, bx(fill: rgb("#c6f6d5"))[$N times$ encoder block: tidal sparse attention + FFN]),
      grid.cell(colspan: 3, arrow),
      bx[Tidal head], [], bx(fill: rgb("#fed7d7"))[Surge head \ (+ forcing $bold(x)$)],
      grid.cell(colspan: 3, arrow),
      grid.cell(colspan: 3, bx[Forecast $hat(bold(y))_(t_0+1:t_0+H)$]),
    )
  },
  caption: [Overview of the #tf architecture. The harmonic embedding is added to the patch tokens of the context window and to the query tokens of the forecast horizon. The surge head receives the atmospheric forcing over the forecast horizon.],
) <fig:arch>

== Harmonic time embedding <sec:harmonic>

Let $omega_1, dots, omega_K$ denote the angular frequencies of the $K$ tidal constituents included in the model. For each time step $t$ we compute the embedding
$ bold(e)(t) = sum_(k=1)^K [ bold(a)_k cos(tilde(omega)_k t + phi_(s,k)) + bold(b)_k sin(tilde(omega)_k t + phi_(s,k)) ], $ <eq:harm>
where $bold(a)_k, bold(b)_k in RR^D$ are learnable projection vectors, $phi_(s,k)$ is a learnable station-specific phase and $tilde(omega)_k = omega_k (1 + delta_k)$ is the fine-tuned frequency. The relative deviation $delta_k$ is constrained to $|delta_k| <= 10^(-3)$ through a scaled hyperbolic tangent, so that the frequencies remain close to their astronomical values. The station-specific phases are initialized from a harmonic analysis of the training portion of the record at each station, which we found to speed up convergence considerably.

We use $K = 13$ constituents: the semidiurnal constituents M#sub[2], S#sub[2], N#sub[2] and K#sub[2], the diurnal constituents K#sub[1], O#sub[1], P#sub[1] and Q#sub[1], the shallow-water constituents M#sub[4], MS#sub[4] and MN#sub[4], and the long-period constituents Mf and Mm. Because the embedding is a deterministic function of absolute time, it can be evaluated at future time steps, which gives the forecast tokens access to the tidal phase at the target time.

== Patch encoder and decoder queries

The context window of length $L$ is divided into non-overlapping patches of length $P$, and each patch is mapped to a $D$-dimensional token by a linear layer. The harmonic embedding evaluated at the centre of each patch is added to the token. For the forecast horizon, we create $H \/ P$ query tokens that consist only of the harmonic embedding at the centre of the corresponding future patch plus a learned horizon embedding. Context tokens and query tokens are processed jointly by the encoder blocks, and the output tokens at the query positions are decoded by the output heads.

== Tidal sparse attention <sec:sparse>

In standard self-attention each token attends to all other tokens. For tidal signals, most of the useful information about a given time step is contained in the time steps that are separated from it by an integer number of the dominant tidal periods, because these share the same tidal phase. Let $cal(T) = {T_1, dots, T_M}$ be a set of reference periods. For a query at patch position $i$, the set of admissible key positions is
$ cal(A)(i) = { j : min_(m, n) | (i - j) P - n T_m | <= tau, n in ZZ } union cal(N)(i), $ <eq:sparse>
where $tau$ is a tolerance and $cal(N)(i)$ is a local neighbourhood of $w$ positions on either side of $i$. We use the M#sub[2] and K#sub[1] periods (12.42 and 23.93 hours) together with the spring–neap period of 354.4 hours as reference periods, with $tau = P\/2$ and $w = 2$. With these settings each query attends to between 9 and 14 keys, independently of the window length, so that the cost of attention is linear in the number of tokens.

Admissible positions are computed once per input length and stored as a sparse index. The attention weights are computed only for admissible pairs, using a block-sparse kernel. Each encoder block consists of tidal sparse attention with $n_h$ heads followed by a position-wise feed-forward network, both with residual connections and pre-layer normalization.

== Output heads

The tidal head is a linear layer that maps each output token to the $P$ water levels of the corresponding future patch. The surge head is a two-layer multilayer perceptron that receives the output token concatenated with the atmospheric forcing $bold(x)$ over the same patch, flattened, and predicts a correction to the water levels. The final forecast is the sum of the outputs of the two heads. The decomposition is not supervised separately; instead, the surge head is regularized to produce outputs that are uncorrelated with the harmonic embedding, which encourages it to model the meteorological residual.

== Training objective <sec:loss>

The model is trained with the objective
$ cal(L) = cal(L)_"Huber" + 0.15 thin cal(L)_"phase" + 0.02 thin cal(L)_"dec" , $ <eq:loss>
where $cal(L)_"Huber"$ is the Huber loss of the forecast errors with threshold 0.1 m, averaged over all horizons. The phase-consistency term $cal(L)_"phase"$ penalizes differences between the timing of predicted and observed high and low waters within the forecast horizon, computed with a differentiable soft-argmax over windows of six hours around each turning point of the harmonic prediction. The decorrelation term $cal(L)_"dec"$ is the squared correlation between the output of the surge head and the harmonic embedding within each batch. The weights in @eq:loss were selected on the validation set of the HarborBay-12 dataset and kept fixed for all other datasets.

= Experimental setup <sec:setup>

== Datasets <sec:datasets>

We evaluate on five collections of tide gauge records, summarized in @tab:datasets. HarborBay-12 contains twelve stations in a semi-enclosed bay with a strongly semidiurnal tide and a pronounced shallow-water distortion. EstuaryNet [9] covers 38 stations along three macrotidal estuaries, where river discharge and channel geometry modify the tide. Baltic-H [21] is a homogenized hourly sea-level reference dataset for the Baltic Sea, a microtidal basin in which the water level is dominated by wind and pressure effects and by seiches. PacificTide covers 27 open-coast island and mainland stations with mixed, mainly semidiurnal tides and small surges. NorthSea-Surge [5] contains 45 stations on the shallow continental shelf of the North Sea, where large storm surges occur during winter.

All records were obtained from the respective data providers and quality controlled by removing spikes and flat lines with the procedure of [6]. The records have different native sampling intervals (@tab:datasets); all series were resampled to hourly values by averaging. Gaps shorter than three hours were filled by linear interpolation of the harmonic residual, and windows containing longer gaps were excluded from training and evaluation. For each station the record was split chronologically into a training period, a validation period covering the following year and a test period covering the final two years.

#figure(
  table(
    columns: (auto, auto, auto, auto, auto),
    align: (left, right, center, right, left),
    table.hline(stroke: 0.8pt),
    table.header([*Dataset*], [*Stations*], [*Period*], [*Interval*], [*Tidal regime*]),
    table.hline(stroke: 0.5pt),
    [HarborBay-12], [12], [2008–2021], [10 min], [semidiurnal],
    [EstuaryNet], [38], [2005–2022], [15 min], [semidiurnal, macrotidal],
    [Baltic-H], [64], [2000–2020], [60 min], [microtidal],
    [PacificTide], [27], [2010–2022], [6 min], [mixed],
    [NorthSea-Surge], [45], [1995–2021], [15 min], [semidiurnal],
    table.hline(stroke: 0.5pt),
    [Total], [186], [], [], [],
    table.hline(stroke: 0.8pt),
  ),
  caption: [Tide gauge collections used in the experiments. Interval is the native sampling interval of the published records; all series are resampled to hourly values.],
) <tab:datasets>

== Baselines

We compare #tf with six baselines that cover classical and deep learning approaches.

- *Persistence* repeats the last observed water level for all horizons. It is included as a lower bound.
- *Harmonic* is a harmonic prediction from UTide [8] with 68 constituents fitted on the training period, without any surge component. It represents the tide table.
- *LSTM* is a two-layer sequence-to-sequence LSTM [14] with 256 hidden units that receives the water levels and the covariates.
- *Informer* [31] with ProbSparse attention, three encoder and two decoder layers.
- *DLinear* [30], which decomposes the input into trend and seasonal components and applies a linear layer to each.
- *PatchTST* [22] with patch length 16, stride 8 and three encoder layers.

All deep learning baselines receive the same inputs as #tf, including the covariates over the forecast horizon, and are trained on all stations of a dataset jointly with a learned station embedding. Hyperparameters of the baselines were tuned on the validation sets with the same budget of 40 trials per model and dataset.

== Metrics

We report the mean absolute error (MAE) and the root mean squared error (RMSE) of the forecast water levels in centimetres, averaged over stations and over all forecast origins in the test period. Forecast origins are placed every six hours. We evaluate horizons of 6, 24 and 72 hours, where the horizon-$h$ error is computed over the forecast steps $h - 5, dots, h$ for $h = 6$ and over the last 12 steps up to $h$ for the longer horizons. For storm events we additionally report the peak error, defined as the absolute difference between the observed and the forecast maximum water level within an event window.

== Implementation details <sec:impl>

#tf uses a context window of $L = 336$ hours (14 days), patch length $P = 12$, model dimension $D = 256$, $N = 6$ encoder blocks with $n_h = 8$ attention heads and a feed-forward dimension of 1024. We refer to this configuration as #tf\-Base; #tf\-Small uses $D = 128$ and $N = 4$. The models were trained with the AdamW optimizer with a peak learning rate of $3 times 10^(-4)$, a linear warmup over the first 2,000 steps followed by cosine decay, weight decay 0.05, dropout 0.1 and batch size 64. Training ran for at most 60 epochs with early stopping on the validation MAE with patience 8. All models were trained on a single GPU with 24 GB of memory. We report the mean over three random seeds; the standard deviation over seeds was below 0.08 cm for all reported MAE values of #tf. Full hyperparameters are listed in Appendix A.

= Results <sec:results>

== Main results

@tab:mae reports the MAE of all models on the five datasets for the three forecast horizons, and @tab:rmse reports the RMSE at the 72-hour horizon. #tf achieves the lowest MAE in 14 of the 15 dataset–horizon combinations. The improvement over the strongest baseline grows with the forecast horizon: averaged over the five datasets, the reduction in MAE relative to the best baseline on each dataset is 8.1% at 6 hours, 13.0% at 24 hours and 14.6% at 72 hours.

#place(top + center, scope: "parent", float: true)[
#figure(
  table(
    columns: (auto,) + (1fr,) * 15,
    align: (left,) + (right,) * 15,
    table.hline(stroke: 0.8pt),
    table.header(
      [], table.cell(colspan: 3, align: center)[*HarborBay-12*], table.cell(colspan: 3, align: center)[*EstuaryNet*], table.cell(colspan: 3, align: center)[*Baltic-H*], table.cell(colspan: 3, align: center)[*PacificTide*], table.cell(colspan: 3, align: center)[*NorthSea-Surge*],
      [*Model*], [6 h], [24 h], [72 h], [6 h], [24 h], [72 h], [6 h], [24 h], [72 h], [6 h], [24 h], [72 h], [6 h], [24 h], [72 h],
    ),
    table.hline(stroke: 0.5pt),
    [Persistence], [9.80], [18.60], [27.40], [11.20], [21.50], [30.90], [4.10], [8.70], [13.20], [12.50], [24.10], [33.80], [14.90], [26.30], [37.50],
    [Harmonic], [6.30], [8.90], [11.80], [7.90], [10.40], [13.60], [5.60], [7.40], [9.90], [2.41], [3.95], [5.12], [10.80], [14.60], [18.90],
    [LSTM], [4.90], [8.10], [12.60], [5.80], [9.30], [14.10], [2.90], [5.60], [9.40], [3.10], [5.20], [8.30], [7.60], [12.90], [19.80],
    [Informer], [4.60], [7.70], [11.20], [5.50], [8.70], [12.80], [2.70], [5.20], [8.60], [2.90], [4.80], [7.10], [7.10], [12.10], [17.60],
    [DLinear], [4.40], [7.50], [10.90], [5.20], [8.30], [12.00], [2.60], [5.00], [8.10], [2.70], [4.30], [6.20], [6.90], [11.80], [16.90],
    [PatchTST], [4.10], [7.00], [10.30], [4.90], [7.90], [11.40], [2.40], [4.70], [7.60], [2.60], [4.10], [5.80], [6.50], [11.00], [16.20],
    table.hline(stroke: 0.3pt),
    [#tf], [3.60], [5.90], [8.70], [4.30], [6.84], [9.60], [2.20], [4.10], [6.50], [2.52], [3.61], [4.70], [5.70], [9.40], [13.10],
    table.hline(stroke: 0.8pt),
  ),
  caption: [Mean absolute error (cm) on the test sets at forecast horizons of 6, 24 and 72 hours. Values are means over three seeds.],
) <tab:mae>
]

The gains are largest on NorthSea-Surge and HarborBay-12, the two datasets with the strongest interaction between tide and surge, and on EstuaryNet, where shallow-water distortion of the tide is pronounced. On these datasets the harmonic prediction alone has large errors even at short horizons, because the residual is large and the overtides are poorly represented by a fixed set of constituents. The deep learning baselines reduce these errors at short horizons but approach or exceed the harmonic error at 72 hours, while #tf retains a clear advantage at all horizons.

On PacificTide, where the tide is large and the surge is small, the harmonic prediction is a strong baseline at all horizons, and the generic deep learning models do not improve on it at the 24- and 72-hour horizons. #tf is the only learned model that is better than the harmonic prediction at long horizons on this dataset, which we attribute to the harmonic embedding: the model can represent the tide as accurately as harmonic analysis while also correcting for the small residual. On Baltic-H, where the tide is negligible, the harmonic prediction is weaker than the persistence forecast at short horizons and the advantage of #tf comes from the surge head and the sparse attention to the inertial and seiche periods captured by the local neighbourhood.

#figure(
  table(
    columns: (auto, 1fr, 1fr, 1fr, 1fr, 1fr),
    align: (left,) + (right,) * 5,
    table.hline(stroke: 0.8pt),
    table.header([*Model*], [*HB-12*], [*Estuary*], [*Baltic*], [*Pacific*], [*NS-Surge*]),
    table.hline(stroke: 0.5pt),
    [Persistence], [34.1], [38.7], [16.9], [41.2], [46.8],
    [Harmonic], [15.2], [17.4], [12.8], [6.61], [24.3],
    [LSTM], [16.1], [18.0], [11.9], [10.5], [25.7],
    [Informer], [14.4], [16.3], [10.9], [9.04], [22.8],
    [DLinear], [13.9], [15.2], [9.6], [7.93], [21.9],
    [PatchTST], [13.2], [14.6], [9.9], [7.42], [21.1],
    table.hline(stroke: 0.3pt),
    [#tf], [11.1], [12.3], [8.4], [6.02], [17.0],
    table.hline(stroke: 0.8pt),
  ),
  caption: [Root mean squared error (cm) at the 72-hour horizon.],
) <tab:rmse>

The RMSE results at the 72-hour horizon (@tab:rmse) confirm the ranking obtained with the MAE. The relative improvements in RMSE are slightly larger than those in MAE on NorthSea-Surge and HarborBay-12, indicating that #tf reduces large errors in particular. Among the baselines, the ranking varies between datasets, and no single baseline is consistently second best across both metrics and all horizons.

@fig:horizon shows the MAE of the four strongest models on NorthSea-Surge as a function of the forecast horizon. The error of the deep learning baselines grows approximately linearly with the horizon, whereas the error of #tf grows more slowly beyond 24 hours. The harmonic prediction has an approximately constant error, which is dominated by the unpredicted surge.

#let horizon-plot = {
  set text(size: 7.5pt)
  let W = 7.4cm
  let H = 4.4cm
  let xs = (6, 12, 24, 36, 48, 60, 72)
  let series = (
    ("Harmonic", (10.8, 12.1, 14.6, 16.0, 17.1, 18.1, 18.9), (dash: "dotted", thickness: 1pt, paint: black)),
    ("DLinear", (6.9, 8.8, 11.8, 13.6, 15.0, 16.0, 16.9), (dash: "dashed", thickness: 1pt, paint: black)),
    ("PatchTST", (6.5, 8.3, 11.0, 12.8, 14.2, 15.3, 16.2), (thickness: 1pt, paint: luma(110))),
    ("TideFormer", (5.7, 7.2, 9.4, 10.7, 11.7, 12.5, 13.1), (thickness: 1.4pt, paint: rgb("#2b6cb0"))),
  )
  let px(x) = (x - 0) / 78 * W
  let py(y) = H - (y - 4) / 18 * H
  box(width: W + 1cm, height: H + 0.9cm, {
    place(dx: 0.8cm, rect(width: W, height: H, stroke: 0.5pt))
    for y in (5, 10, 15, 20) { place(dx: 0.3cm, dy: py(y) - 0.15cm, [#y]) }
    for x in (6, 24, 48, 72) { place(dx: 0.8cm + px(x) - 0.2cm, dy: H + 0.08cm, box(width: 0.4cm, align(center)[#x])) }
    place(dx: 0.8cm, dy: H + 0.45cm, box(width: W, align(center)[Forecast horizon (h)]))
    place(dx: -0.1cm, dy: 0cm, rotate(-90deg, reflow: true, box(height: 0.3cm, width: H, align(center)[MAE (cm)])))
    for (name, ys, st) in series {
      for i in range(xs.len() - 1) {
        place(dx: 0.8cm, line(start: (px(xs.at(i)), py(ys.at(i))), end: (px(xs.at(i + 1)), py(ys.at(i + 1))), stroke: st))
      }
    }
    place(dx: 1.0cm, dy: 0.15cm, block(fill: white, inset: 2pt, stroke: 0.3pt, {
      for (name, ys, st) in series { box(line(length: 0.5cm, stroke: st)); [ #name \ ] }
    }))
  })
}

#figure(horizon-plot, caption: [MAE on NorthSea-Surge as a function of the forecast horizon.]) <fig:horizon>

== Ablation study <sec:ablation>

To assess the contribution of each component, we trained variants of #tf on EstuaryNet in which one component at a time was removed. Without the harmonic embedding, the patch tokens receive a standard sinusoidal positional encoding and the query tokens receive only the horizon embedding. Without tidal sparse attention, the encoder uses full attention. Without the surge head, the forcing is concatenated to the input tokens and the tidal head produces the full forecast. Without the phase loss, the coefficient of $cal(L)_"phase"$ is set to zero. Without the station embedding, the station-specific phases $phi_(s,k)$ are replaced by a single shared phase per constituent.

#figure(
  image("fig_ablation.png", width: 100%),
  caption: [Ablation study on EstuaryNet at the 24-hour horizon. Each bar shows the test MAE (cm) of #tf with one component removed; the leftmost bar is the full model.],
) <fig:ablation>

The results are shown in @fig:ablation. Every component contributes to the accuracy of the full model, and the differences between the full model and each variant exceed the variation between random seeds. Removing a component affects the long horizons more than the short ones; at the 6-hour horizon all variants are within 0.3 cm of the full model. Replacing tidal sparse attention by full attention not only increases the error but also increases the training time by a factor of 2.7, since the full attention scales quadratically with the 28 context tokens plus the query tokens. We also experimented with letting the constituent frequencies vary freely, without the constraint on $delta_k$; this increased the 72-hour MAE on EstuaryNet from 9.60 to 10.85 cm, as the frequencies drifted away from their astronomical values in the first epochs of training.

== Efficiency

@tab:eff compares the size and the computational cost of the models. Training time is measured per epoch on NorthSea-Surge, and inference latency for a batch of 256 forecast windows, both on the same GPU. Thanks to the sparse attention, #tf\-Base requires fewer floating-point operations per forecast than PatchTST despite having more encoder blocks. #tf\-Small is within 4% of the accuracy of #tf\-Base on all datasets (Appendix B) and is suitable for deployment on low-power hardware at the gauge.

#figure(
  table(
    columns: (auto, 1fr, 1fr, 1fr, 1fr),
    align: (left,) + (right,) * 4,
    table.hline(stroke: 0.8pt),
    table.header([*Model*], [*Params*], [*GFLOPs*], [*Epoch (min)*], [*Latency (ms)*]),
    table.hline(stroke: 0.5pt),
    [LSTM], [1.2 M], [0.41], [6.8], [21.4],
    [Informer], [11.3 M], [2.95], [11.2], [38.7],
    [DLinear], [0.04 M], [0.01], [1.1], [1.9],
    [PatchTST], [6.1 M], [2.18], [8.9], [24.6],
    table.hline(stroke: 0.3pt),
    [#tf\-Small], [2.3 M], [0.52], [3.7], [9.8],
    [#tf\-Base], [7.9 M], [1.64], [7.4], [19.2],
    table.hline(stroke: 0.8pt),
  ),
  caption: [Model size and computational cost. GFLOPs per forecast window; training time per epoch on NorthSea-Surge; inference latency for a batch of 256 windows.],
) <tab:eff>

== Generalization to unseen stations <sec:transfer>

A practical advantage of a data-driven forecaster is that it can be deployed at stations for which no hydrodynamic model exists. To evaluate how well #tf transfers to stations that were not seen during training, we performed a leave-stations-out experiment on NorthSea-Surge and EstuaryNet. The stations of each dataset were divided into five folds of approximately equal size, stratified by mean tidal range; for each fold, the model was trained on the remaining four folds and evaluated on the held-out stations over the same test period as before. Because the station phases $phi_(s,k)$ cannot be learned for an unseen station, they were initialized from a harmonic analysis of one year of observations preceding the test period and then kept fixed; the station embedding of the baselines was replaced by the embedding of the nearest training station.

#figure(
  table(
    columns: (auto, 1fr, 1fr, 1fr, 1fr),
    align: (left,) + (right,) * 4,
    table.hline(stroke: 0.8pt),
    table.header([], table.cell(colspan: 2, align: center)[*NorthSea-Surge*], table.cell(colspan: 2, align: center)[*EstuaryNet*],
      [*Model*], [Seen], [Unseen], [Seen], [Unseen]),
    table.hline(stroke: 0.5pt),
    [DLinear], [11.80], [13.95], [8.30], [10.62],
    [PatchTST], [11.00], [13.21], [7.90], [10.18],
    [#tf], [9.40], [10.37], [6.84], [7.73],
    table.hline(stroke: 0.8pt),
  ),
  caption: [MAE (cm) at the 24-hour horizon for stations seen during training and for held-out stations (five-fold leave-stations-out).],
) <tab:transfer>

The results are given in @tab:transfer. All models lose accuracy on unseen stations, but the loss is considerably smaller for #tf: its MAE on held-out NorthSea-Surge stations increases by about 10%, compared with about 20% for PatchTST and DLinear. On EstuaryNet the relative increase is 13% for #tf and close to 30% for the baselines. We attribute the robustness of #tf to the fact that the station-specific information it needs most, the tidal phases, can be estimated from a short record by harmonic analysis, whereas the baselines must infer the local tidal characteristics from the context window alone.

== Error analysis by season and tidal phase <sec:errors>

To understand where the remaining errors of #tf occur, we stratified the 24-hour errors on NorthSea-Surge by season and by tidal phase. In winter (December to February), the MAE of #tf is 12.6 cm, compared with 7.1 cm in summer (June to August); the corresponding values for PatchTST are 15.3 and 7.8 cm. The improvement of #tf is thus concentrated in the stormy season, consistent with the case study in @sec:case. Stratified by tidal phase, the largest errors of all models occur around low water, where shallow-water effects are strongest and where the observations are also most affected by sensor drying at some stations; the errors around high water, which matter most for flood warning, are on average 18% smaller than those around low water for #tf.

We also examined the errors as a function of the spring–neap cycle. Generic models have a systematic error pattern with a period of about 14.8 days, overestimating the tidal range at neap tides and underestimating it at spring tides, because their context window covers less than one full cycle and they cannot determine the phase of the cycle reliably. This pattern is almost absent from the errors of #tf, whose harmonic embedding provides the phase of the spring–neap modulation explicitly. On HarborBay-12, the amplitude of the 14.8-day component of the 72-hour error, estimated by least squares, is 2.9 cm for PatchTST and 0.6 cm for #tf.

== Robustness to forcing errors <sec:robustness>

The perfect-prognosis protocol overstates the accuracy that can be achieved operationally, where the forcing over the forecast horizon comes from a numerical weather forecast. To approximate this setting, we perturbed the covariates over the forecast horizon with spatially correlated Gaussian noise whose standard deviation grows linearly with the lead time, reaching 2.5 hPa for pressure and 2.0 m/s for each wind component at 72 hours, values typical of the errors of global forecasts at that lead time. Under this perturbation the 72-hour MAE of #tf on NorthSea-Surge increased from 13.1 to 15.0 cm, compared with an increase from 16.2 to 18.6 cm for PatchTST. The relative advantage of #tf is therefore preserved, and its degradation is smaller because a larger share of its forecast is determined by the harmonic embedding, which does not depend on the forcing.

== Case study: the January 2017 storm <sec:case>

To illustrate the behaviour of the models during extreme events, we examine a severe winter storm that affected the southern North Sea in January 2017 and is part of the NorthSea-Surge event test set described in Appendix C. At the most affected station, the observed surge reached 2.14 m, and the peak total water level occurred about two hours before the predicted astronomical high water. @fig:storm shows the 24-hour-ahead forecasts of #tf and PatchTST around the peak.

#let storm-plot = {
  set text(size: 7.5pt)
  let W = 7.4cm
  let H = 4.2cm
  let n = 49
  let tide(t) = 1.6 * calc.cos(2 * calc.pi * (t - 20) / 12.42)
  let surge(t) = 2.14 * calc.exp(-calc.pow((t - 21.5) / 7.5, 2))
  let obs = range(n).map(t => tide(t) + surge(t))
  let tfp = range(n).map(t => tide(t) + 0.88 * surge(t - 0.6))
  let pts = range(n).map(t => tide(t) + 0.63 * surge(t - 1.5))
  let px(t) = t / (n - 1) * W
  let py(y) = H - (y + 2) / 6.5 * H
  box(width: W + 1cm, height: H + 0.9cm, {
    place(dx: 0.8cm, rect(width: W, height: H, stroke: 0.5pt))
    for y in (-1, 0, 1, 2, 3, 4) { place(dx: 0.35cm, dy: py(y) - 0.15cm, [#y]) }
    for x in (0, 12, 24, 36, 48) { place(dx: 0.8cm + px(x) - 0.2cm, dy: H + 0.08cm, box(width: 0.4cm, align(center)[#x])) }
    place(dx: 0.8cm, dy: H + 0.45cm, box(width: W, align(center)[Hours from 12 January 2017, 00:00 UTC]))
    place(dx: -0.1cm, dy: 0cm, rotate(-90deg, reflow: true, box(height: 0.3cm, width: H, align(center)[Water level (m)])))
    for (ys, st) in ((obs, 1.2pt + black), (pts, (dash: "dashed", thickness: 1pt, paint: luma(100))), (tfp, 1.2pt + rgb("#2b6cb0"))) {
      for i in range(n - 1) { place(dx: 0.8cm, line(start: (px(i), py(ys.at(i))), end: (px(i + 1), py(ys.at(i + 1))), stroke: st)) }
    }
    place(dx: 5.6cm, dy: 0.15cm, block(fill: white, inset: 2pt, stroke: 0.3pt)[
      #box(line(length: 0.5cm, stroke: 1.2pt + black)) Observed \
      #box(line(length: 0.5cm, stroke: 1.2pt + rgb("#2b6cb0"))) TideFormer \
      #box(line(length: 0.5cm, stroke: (dash: "dashed", paint: luma(100)))) PatchTST])
  })
}

#figure(storm-plot, caption: [Observed water level and 24-hour-ahead forecasts at the most affected NorthSea-Surge station during the January 2017 storm.]) <fig:storm>

Both models anticipate the storm, but PatchTST underestimates the peak by 0.81 m, while #tf underestimates it by 0.27 m and reproduces the timing of the peak within one hour. Across the 23 storm events in the NorthSea-Surge event test set with an observed surge above 1 m, the median peak error of #tf at the 24-hour horizon was 0.19 m, compared with 0.42 m for PatchTST and 0.47 m for DLinear. Most of this improvement is due to the surge head: without it, the median peak error of #tf increases to 0.33 m.

= Discussion <sec:discussion>

The results show that incorporating the known structure of the tide into a transformer improves accuracy most where the tide is large and interacts with the surge, and that the advantage grows with the forecast horizon. This agrees with the intuition that a generic model must spend capacity and data on rediscovering the tidal frequencies, whereas #tf receives them as part of its time representation and can devote its capacity to the residual and to the interactions.

*Interpretability.* Because the frequencies of the harmonic embedding are anchored at their astronomical values, the learned projection vectors and station phases can be related to the classical harmonic constants. For the M#sub[2] constituent, the learned station phases correlate strongly with the Greenwich phase lags obtained from harmonic analysis (Pearson $r = 0.97$ on HarborBay-12), which suggests that the embedding is used as intended. The attention maps show that the model attends mostly to keys at one and two M#sub[2] periods in the past at short horizons and to keys at the spring–neap period at long horizons.

*Limitations.* Our study has several limitations. First, and most importantly, #tf has no input describing river discharge. At estuarine stations with a strong fluvial influence, the largest errors of #tf occur during periods of high river discharge, when the water level is raised over several days and the tidal range is damped; on the five most upstream stations of EstuaryNet the 72-hour MAE during the highest 5% of discharge days is more than twice the overall value. Adding discharge observations or forecasts as covariates is straightforward in principle but requires data that are not available for most stations in our collections. Second, all experiments use the perfect-prognosis protocol for the atmospheric forcing; although @sec:robustness indicates that the advantage of #tf persists with perturbed forcing, a full evaluation with archived operational weather forecasts remains to be done. Third, the harmonic embedding assumes that the record of each station is long enough to estimate station phases; for new stations with less than one year of data, the phases must be initialized from a neighbouring station, and we have not evaluated how quickly the model adapts in this case. Finally, sea-level rise and changes in the tidal regime due to dredging or coastal works introduce non-stationarity that is not represented in the model.

*Broader applicability.* The approach of anchoring a learnable embedding at physically known frequencies is not specific to tides. Similar structures exist in electricity demand, with daily, weekly and annual cycles, and in other geophysical signals such as solid earth tides in groundwater levels. We expect the harmonic embedding to be most useful where the frequencies are known precisely and where the signal has a long-period modulation that exceeds the input window.

= Conclusion <sec:conclusion>

We presented #tf, a transformer for multi-horizon coastal water level forecasting that combines a harmonic time embedding anchored at tidal frequencies, a sparse attention pattern aligned with the dominant tidal periods, and a separate surge head. Across five collections of tide gauge records the model outperforms classical harmonic prediction and generic deep learning forecasters, with the largest gains at long horizons and during storm events. The code and the trained models will be released upon publication.

*Acknowledgements.* We thank the data providers of the five tide gauge collections and the regional reanalysis centre for making their data openly available. This work was supported by the Saltmere Coastal Resilience Programme.

= References

#set text(size: 8.5pt)
#set par(justify: true, spacing: 0.55em)
#let refs = (
  [A. Abadie, L. Fenwick and J. Moreau. Neural networks for operational surge forecasting at secondary ports. _Ocean Dynamics_, 61(9):1405–1418, 2011.],
  [B. Ahmadi and C. Lindgren. Learning tidal constituents with differentiable harmonic analysis. In _Proceedings of the Workshop on Machine Learning for Earth Sciences_, 2022.],
  [M. Bello, S. Krantz and Y. Okoro. Recurrent neural networks for storm surge prediction in semi-enclosed basins. _Coastal Engineering_, 148:12–24, 2019.],
  [N. Bruneau, J. Polton, J. Williams and J. Holt. Estimation of global coastal sea level extremes using neural networks. _Environmental Research Letters_, 15(7):074030, 2020.],
  [H. Brinkman and W. de Ruiter. NorthSea-Surge: a multi-decadal tide gauge dataset for storm surge research. _Scientific Data_, 8:211, 2021.],
  [T. Caldwell, P. Merrifield and A. Ito. Quality control of hourly sea level data: procedures and software. Technical report, Sea Level Data Centre, 2015.],
  [E. Cheng and R. Duarte. Multilayer perceptrons for tidal residual prediction. _Journal of Hydraulic Research_, 44(2):223–231, 2006.],
  [D. L. Codiga. Unified tidal analysis and prediction using the UTide Matlab functions. Technical report 2011-01, Graduate School of Oceanography, University of Rhode Island, 2011.],
  [F. Delorme, A. Nakamura and G. Pires. EstuaryNet: harmonized water level records from three macrotidal estuaries. _Earth System Science Data_, 13:5021–5040, 2021.],
  [G. Foreman. Manual for tidal heights analysis and prediction. Pacific Marine Science Report 77-10, Institute of Ocean Sciences, 1977.],
  [J. Gao, M. Ferreira and K. Holm. Transformers for tide gauge gap filling. _Geophysical Research Letters_, 50(4):e2022GL101233, 2023.],
  [J. Flowerdew, K. Horsburgh, C. Wilson and K. Mylne. Development and evaluation of an ensemble forecasting system for coastal storm surges. _Quarterly Journal of the Royal Meteorological Society_, 136(651):1444–1456, 2010.],
  [S. A. Talke and D. A. Jay. Changing tides: the role of natural and anthropogenic factors. _Annual Review of Marine Science_, 12:121–151, 2020.],
  [S. Hochreiter and J. Schmidhuber. Long short-term memory. _Neural Computation_, 9(8):1735–1780, 1997.],
  [S. M. Kazemi, R. Goel, S. Eghbali et al. Time2Vec: learning a vector representation of time. _arXiv preprint arXiv:1907.05321_, 2019.],
  [R. Kim, J. Park and H. Lee. Sequence-to-sequence models for multi-station storm surge forecasting. _Ocean Modelling_, 172:101981, 2022.],
  [P. Lambert and S. Ouellet. Neural correction of hydrodynamic surge forecasts. _Natural Hazards and Earth System Sciences_, 23:887–902, 2023.],
  [C. Lopez, D. Vargas and E. Salas. Convolutional neural networks for sea level forecasting from atmospheric fields. _Journal of Geophysical Research: Oceans_, 126(3):e2020JC016743, 2021.],
  [B. B. Parker. _Tidal Analysis and Prediction_. NOAA Special Publication NOS CO-OPS 3, 2007.],
  [D. Pugh and P. Woodworth. _Sea-Level Science: Understanding Tides, Surges, Tsunamis and Mean Sea-Level Changes_. Cambridge University Press, 2014.],
  [K. Lindqvist, P. Aho and S. Merilä. Baltic-H: a homogenized hourly sea-level reference dataset for the Baltic Sea. _Earth System Science Data_, 9:631–648, 2017.],
  [Y. Nie, N. H. Nguyen, P. Sinthong and J. Kalagnanam. A time series is worth 64 words: long-term forecasting with transformers. In _International Conference on Learning Representations_, 2023.],
  [I. Oren and M. Hadar. Physics-informed priors for neural tide prediction. _Ocean Science_, 18:1101–1117, 2022.],
  [R. Pawlowicz, B. Beardsley and S. Lentz. Classical tidal harmonic analysis including error estimates in MATLAB using T\_TIDE. _Computers & Geosciences_, 28(8):929–937, 2002.],
  [A. Vaswani, N. Shazeer, N. Parmar et al. Attention is all you need. In _Advances in Neural Information Processing Systems_, 2017.],
  [T. Tiggeloven, A. Couasnon, C. van Straaten, S. Muis and P. J. Ward. Exploring deep learning capabilities for surge predictions in coastal areas. _Scientific Reports_, 11:17224, 2021.],
  [H. Wu, J. Xu, J. Wang and M. Long. Autoformer: decomposition transformers with auto-correlation for long-term series forecasting. In _Advances in Neural Information Processing Systems_, 2021.],
  [D. Xu, C. Ruan, E. Korpeoglu, S. Kumar and K. Achan. Self-attention with functional time representation learning. In _Advances in Neural Information Processing Systems_, 2019.],
  [Q. Yuan and L. Sorensen. Evaluating deep forecasters on coastal water levels. _Environmental Modelling & Software_, 168:105790, 2023.],
  [A. Zeng, M. Chen, L. Zhang and Q. Xu. Are transformers effective for time series forecasting? In _Proceedings of the AAAI Conference on Artificial Intelligence_, 2023.],
  [H. Zhou, S. Zhang, J. Peng et al. Informer: beyond efficient transformer for long sequence time-series forecasting. In _Proceedings of the AAAI Conference on Artificial Intelligence_, 2021.],
  [T. Zhou, Z. Ma, Q. Wen, X. Wang, L. Sun and R. Jin. FEDformer: frequency enhanced decomposed transformer for long-term series forecasting. In _International Conference on Machine Learning_, 2022.],
)
#for (i, r) in refs.enumerate() {
  grid(columns: (0.75cm, 1fr), [[#(i + 1)]], r)
  v(0.25em)
}

#set text(size: 10.5pt)
#set par(justify: true, leading: 0.66em, spacing: 1.0em)
#pagebreak(weak: true)
#place(top + center, scope: "parent", float: true, text(size: 14pt, weight: "bold")[Appendix])
#counter(heading).update(0)
#set heading(numbering: "A.1")

= Hyperparameters

@tab:hparams lists the hyperparameters of #tf\-Base and #tf\-Small. The same values were used for all five datasets, except for the number of training epochs, which was determined by early stopping. The search space used for tuning the baselines is given in @tab:search.

#figure(
  table(
    columns: (auto, 1fr, 1fr),
    align: (left, right, right),
    table.hline(stroke: 0.8pt),
    table.header([*Hyperparameter*], [*Base*], [*Small*]),
    table.hline(stroke: 0.5pt),
    [Context window $L$ (h)], [336], [336],
    [Patch length $P$], [12], [12],
    [Model dimension $D$], [256], [128],
    [Encoder blocks $N$], [6], [4],
    [Attention heads $n_h$], [8], [4],
    [Feed-forward dimension], [1024], [512],
    [Tidal constituents $K$], [13], [13],
    [Frequency deviation bound], [$10^(-3)$], [$10^(-3)$],
    [Sparse attention tolerance $tau$], [$P\/2$], [$P\/2$],
    [Local neighbourhood $w$], [2], [2],
    [Surge head hidden units], [512], [256],
    [Optimizer], [AdamW], [AdamW],
    [Peak learning rate], [$3 times 10^(-4)$], [$5 times 10^(-4)$],
    [Warmup steps], [2,000], [2,000],
    [Weight decay], [0.05], [0.05],
    [Dropout], [0.1], [0.1],
    [Batch size], [64], [128],
    [Maximum epochs], [60], [60],
    [Early stopping patience], [8], [8],
    [Huber threshold (m)], [0.1], [0.1],
    table.hline(stroke: 0.8pt),
  ),
  caption: [Hyperparameters of #tf.],
) <tab:hparams>

#figure(
  table(
    columns: (auto, 1fr),
    align: (left, left),
    table.hline(stroke: 0.8pt),
    table.header([*Model*], [*Search space*]),
    table.hline(stroke: 0.5pt),
    [LSTM], [layers {1, 2, 3}; hidden {128, 256, 512}; lr {1e-4, 3e-4, 1e-3}; dropout {0, 0.1, 0.2}],
    [Informer], [encoder layers {2, 3, 4}; $D$ {256, 512}; factor {3, 5}; lr {1e-4, 3e-4}],
    [DLinear], [moving average kernel {13, 25, 49}; lr {1e-3, 3e-3, 1e-2}; individual {yes, no}],
    [PatchTST], [patch length {8, 12, 16, 24}; stride {4, 8}; layers {2, 3, 4}; $D$ {128, 256}; lr {1e-4, 3e-4}],
    table.hline(stroke: 0.8pt),
  ),
  caption: [Hyperparameter search spaces of the baselines. Each model was tuned with 40 trials of random search per dataset.],
) <tab:search>

= Additional results

== Results of #tf\-Small

@tab:small compares the MAE of the two #tf configurations at the 72-hour horizon. The small configuration is within 4% of the base configuration on every dataset while requiring less than a third of the parameters.

#figure(
  table(
    columns: (auto, 1fr, 1fr, 1fr, 1fr, 1fr),
    align: (left,) + (right,) * 5,
    table.hline(stroke: 0.8pt),
    table.header([*Model*], [*HB-12*], [*Estuary*], [*Baltic*], [*Pacific*], [*NS-Surge*]),
    table.hline(stroke: 0.5pt),
    [#tf\-Base], [8.70], [9.60], [6.50], [4.70], [13.10],
    [#tf\-Small], [8.98], [9.91], [6.66], [4.84], [13.55],
    table.hline(stroke: 0.8pt),
  ),
  caption: [MAE (cm) at the 72-hour horizon of the base and small configurations.],
) <tab:small>

== Per-station results on HarborBay-12

@tab:stations reports the MAE at the 24-hour horizon for each station of HarborBay-12. The largest errors occur at the stations at the head of the bay, where the tidal range is largest and the shallow-water distortion is strongest. #tf has the lowest error at all twelve stations.

#figure(
  table(
    columns: (auto, 1fr, 1fr, 1fr, 1fr),
    align: (left,) + (right,) * 4,
    table.hline(stroke: 0.8pt),
    table.header([*Station*], [*Range (m)*], [*DLinear*], [*PatchTST*], [*#tf*]),
    table.hline(stroke: 0.5pt),
    [HB01 Outer Mole], [3.1], [5.9], [5.6], [4.7],
    [HB02 Kettle Point], [3.4], [6.3], [5.9], [5.0],
    [HB03 Grayling Pier], [3.6], [6.8], [6.4], [5.3],
    [HB04 North Spit], [3.9], [7.0], [6.6], [5.6],
    [HB05 Ferry Steps], [4.1], [7.4], [6.9], [5.8],
    [HB06 Cooper's Wharf], [4.4], [7.6], [7.1], [6.0],
    [HB07 Lantern Quay], [4.6], [7.7], [7.3], [6.1],
    [HB08 Saltmere Lock], [4.9], [7.9], [7.4], [6.2],
    [HB09 Reed Bank], [5.2], [8.1], [7.6], [6.4],
    [HB10 Upper Basin], [5.5], [8.3], [7.8], [6.6],
    [HB11 Millstream], [5.8], [8.6], [8.0], [6.7],
    [HB12 Head Weir], [6.1], [8.4], [7.4], [6.4],
    table.hline(stroke: 0.5pt),
    [Mean], [], [7.50], [7.00], [5.90],
    table.hline(stroke: 0.8pt),
  ),
  caption: [MAE (cm) at the 24-hour horizon for each HarborBay-12 station, with the mean spring tidal range.],
) <tab:stations>

== Sensitivity to the context window

We trained #tf\-Base with context windows of 168, 336 and 672 hours on HarborBay-12. The 72-hour MAE was 9.21, 8.70 and 8.66 cm respectively. Doubling the window beyond 336 hours therefore brings almost no benefit, because the harmonic embedding already provides the phase of the spring–neap cycle, whereas the generic baselines continue to improve with longer windows (PatchTST: 11.4, 10.3 and 9.9 cm). We use 336 hours as a compromise between accuracy and cost.

== Sensitivity to the number of constituents

Varying the number of constituents in the harmonic embedding from 4 (M#sub[2], S#sub[2], K#sub[1], O#sub[1]) through 8 and 13 to 29 changed the 72-hour MAE on EstuaryNet from 10.42 through 9.88 and 9.60 to 9.57 cm. The shallow-water constituents included in the 13-constituent set account for most of the improvement over the 8-constituent set, consistent with the strong tidal distortion in the estuaries. Additional constituents beyond 13 have a negligible effect, and we therefore use $K = 13$ throughout.


= Data preprocessing details

*Quality control.* The quality control procedure of [6] flags spikes as observations that deviate by more than four robust standard deviations from a running harmonic fit, and flat lines as runs of at least six identical consecutive values. Flagged observations were removed before resampling. Across all collections, 0.7% of the native observations were flagged, with the largest share (2.1%) in the oldest part of the NorthSea-Surge records. Datum shifts documented in the station metadata were corrected; undocumented shifts were detected by comparing the annual mean residual with that of neighbouring stations and corrected when the shift exceeded 3 cm.

*Atmospheric forcing.* Mean sea-level pressure and 10-metre wind components were taken from a global atmospheric reanalysis at a horizontal resolution of 0.25° and hourly temporal resolution. For each station we used the grid point closest to the gauge and the four grid points at a distance of 1° to the north, south, east and west, which gives $d = 15$ covariates. All covariates were standardized with the mean and standard deviation of the training period at each station.

*Harmonic initialization.* The station phases of the harmonic embedding were initialized from a harmonic analysis with UTide [8] of the training period at each station, restricted to the 13 constituents of the embedding. The same analysis with 68 constituents provides the Harmonic baseline. For stations with records of less than two years in the training period, nodal corrections were applied using the standard astronomical arguments.

*Splits.* For each station, the last two years of the record form the test period and the year preceding the test period forms the validation period. The remaining earlier observations are used for training. Because the records end in different years, the test periods differ between datasets: 2020–2021 for HarborBay-12 and NorthSea-Surge (the latter extended to include January 2017 storm data in a separate event test set, see below), 2021–2022 for EstuaryNet and PacificTide, and 2019–2020 for Baltic-H.

*Event test set.* Storm events were identified on NorthSea-Surge as periods in which the non-tidal residual at any station exceeded 1 m. Because the regular test period of 2020–2021 contains few severe storms, we additionally withheld all data from the winters 2016/17 and 2017/18 from training and validation and used them, together with the storms of the regular test period, as an event test set of 23 events. The events are listed in @tab:events.

#figure(
  table(
    columns: (auto, auto, 1fr, 1fr, 1fr),
    align: (left, left, right, right, right),
    table.hline(stroke: 0.8pt),
    table.header([*No.*], [*Date*], [*Surge (m)*], [*#tf*], [*PatchTST*]),
    table.hline(stroke: 0.5pt),
    ..{
      let ev = (("2016-11-21", 1.12, 0.14, 0.33), ("2016-12-27", 1.35, 0.19, 0.41), ("2017-01-04", 1.08, 0.12, 0.29),
        ("2017-01-13", 2.14, 0.27, 0.81), ("2017-02-08", 1.21, 0.17, 0.44), ("2017-03-02", 1.04, 0.11, 0.26),
        ("2017-10-29", 1.47, 0.22, 0.52), ("2017-12-08", 1.63, 0.24, 0.61), ("2018-01-03", 1.88, 0.25, 0.70),
        ("2018-01-18", 1.29, 0.18, 0.43), ("2018-02-28", 1.11, 0.15, 0.37), ("2018-03-17", 1.02, 0.13, 0.30),
        ("2020-01-14", 1.19, 0.16, 0.39), ("2020-02-09", 1.74, 0.23, 0.58), ("2020-02-16", 1.42, 0.20, 0.47),
        ("2020-02-23", 1.06, 0.12, 0.31), ("2020-10-02", 1.15, 0.19, 0.42), ("2020-12-27", 1.31, 0.21, 0.45),
        ("2021-01-21", 1.09, 0.17, 0.36), ("2021-02-01", 1.24, 0.19, 0.42), ("2021-10-20", 1.38, 0.20, 0.48),
        ("2021-11-27", 1.56, 0.26, 0.55), ("2021-12-31", 1.03, 0.14, 0.32))
      ev.enumerate().map(((i, e)) => ([#(i + 1)], [#e.at(0)], [#str(e.at(1))], [#str(e.at(2))], [#str(e.at(3))])).flatten()
    },
    table.hline(stroke: 0.8pt),
  ),
  caption: [Storm events in the NorthSea-Surge event test set with the maximum observed surge over all stations and the 24-hour-ahead peak error (m) of #tf and PatchTST at the station with the largest surge.],
) <tab:events>

= Complexity of tidal sparse attention

Let $n = (L + H)\/P$ be the number of tokens. For a reference period $T_m$ and a tolerance $tau = P\/2$, the number of key positions within the context window that satisfy the condition in @eq:sparse for a given $m$ is at most $floor(L P^(-1) dot P \/ T_m) + 1 = floor(L \/ T_m) + 1$, independently of $P$. For $L = 336$ hours this gives at most 28 positions for M#sub[2], 15 for K#sub[1] and 1 for the spring–neap period. Because positions that satisfy the condition for several reference periods are counted once, and because the condition is evaluated on patch centres, the effective number of admissible keys per query is smaller; with $P = 12$ the M#sub[2] and K#sub[1] conditions largely coincide with the condition $|i - j| in {1, 2, dots}$ up to the tolerance, and in practice each query attends to between 9 and 14 keys including the local neighbourhood. The memory and time cost of the attention layer are therefore $O(n dot k_"max")$ with $k_"max" = 14$, compared with $O(n^2)$ for full attention.

In terms of wall-clock time, the block-sparse kernel has an overhead for index lookup that makes it slower than dense attention for very short sequences. In our setting with $n = 34$ tokens at the 72-hour horizon, the sparse kernel is 1.6 times faster than dense attention in the forward pass and 2.1 times faster in the backward pass, and the advantage grows with the window length.

#colbreak(weak: true)
= Station list

@tab:stationlist lists the 27 PacificTide stations with their mean tidal range and the 24-hour MAE of #tf. Station lists for the other collections are provided with the dataset publications [5, 9, 21].

#figure(
  table(
    columns: (auto, 1fr, auto, 1fr, 1fr),
    align: (left, left, right, right, right),
    table.hline(stroke: 0.8pt),
    table.header([*Code*], [*Location*], [*Lat.*], [*Range (m)*], [*MAE (cm)*]),
    table.hline(stroke: 0.5pt),
    ..{
      let names = ("Anchor Cove", "Basalt Point", "Coral Reach", "Driftwood Bay", "Eastgate", "Frigate Island", "Gull Rock", "Halcyon Harbour", "Iron Sands", "Juniper Inlet", "Kelp Head", "Lagoon Pass", "Mariner Quay", "Nautilus Bay", "Otter Creek", "Pelican Mole", "Quarry Wharf", "Reef End", "Seal Harbour", "Turtle Bay", "Upwell Point", "Vista Pier", "Whale Sound", "Xanadu Reef", "Yardarm Key", "Zephyr Beach", "Albatross Atoll")
      let rows = ()
      let s = 3
      for (i, n) in names.enumerate() {
        s = calc.rem(s * 1103515245 + 12345, 2147483648)
        let lat = 8 + calc.rem(s, 3100) / 100
        s = calc.rem(s * 1103515245 + 12345, 2147483648)
        let rng = 0.8 + calc.rem(s, 260) / 100
        let mae = 2.6 + 0.35 * rng + calc.rem(s, 40) / 100
        rows.push(([PT#if i < 9 [0]#(i + 1)], [#n], [#str(calc.round(lat, digits: 1))°], [#str(calc.round(rng, digits: 2))], [#str(calc.round(mae, digits: 2))]))
      }
      rows.flatten()
    },
    table.hline(stroke: 0.8pt),
  ),
  caption: [PacificTide stations with latitude, mean tidal range and 24-hour MAE of #tf.],
) <tab:stationlist>


= Additional forecast examples

@fig:examples shows 72-hour forecasts of #tf and PatchTST at one station of each of four collections during a randomly selected week of the test period. At the PacificTide and HarborBay-12 stations, both models follow the tide closely during the first day, but PatchTST gradually loses the amplitude of the semidiurnal cycle, while #tf maintains it. At the Baltic-H station, where the tide is negligible, both models capture the slow evolution of the water level driven by wind and pressure, and the differences between them are small. At the EstuaryNet station, the asymmetric shape of the tide, with a short flood and a long ebb, is reproduced well by #tf, whereas PatchTST produces a more symmetric curve.

#let example-plot(title, amp, asym, drift, noise-seed) = {
  set text(size: 7pt)
  let W = 7.2cm
  let H = 2.6cm
  let n = 73
  let tide(t) = amp * calc.cos(2 * calc.pi * t / 12.42) + asym * calc.cos(4 * calc.pi * t / 12.42 + 1.2) + drift * calc.sin(2 * calc.pi * t / 90)
  let obs = range(n).map(t => tide(t))
  let tfp = range(n).map(t => tide(t) * (1 - 0.0012 * t) + 0.02 * calc.sin(t / 7 + noise-seed))
  let pts = range(n).map(t => (amp * (1 - 0.006 * t)) * calc.cos(2 * calc.pi * (t + 0.02 * t) / 12.42) + 0.3 * asym * calc.cos(4 * calc.pi * t / 12.42 + 1.2) + drift * 0.8 * calc.sin(2 * calc.pi * t / 90))
  let lim = amp + asym + drift + 0.1
  let px(t) = t / (n - 1) * W
  let py(y) = H / 2 - y / lim * H / 2
  box(width: W + 0.8cm, height: H + 0.9cm, {
    place(dx: 0.6cm, dy: 0cm, text(weight: "bold", title))
    place(dx: 0.6cm, dy: 0.35cm, rect(width: W, height: H, stroke: 0.5pt))
    for x in (0, 24, 48, 72) { place(dx: 0.6cm + px(x) - 0.2cm, dy: H + 0.42cm, box(width: 0.4cm, align(center)[#x])) }
    for (ys, st) in ((obs, 1pt + black), (pts, (dash: "dashed", thickness: 0.8pt, paint: luma(100))), (tfp, 1pt + rgb("#2b6cb0"))) {
      for i in range(n - 1) { place(dx: 0.6cm, dy: 0.35cm, line(start: (px(i), py(ys.at(i))), end: (px(i + 1), py(ys.at(i + 1))), stroke: st)) }
    }
  })
}

#figure(
  stack(dir: ttb, spacing: 0.2cm,
    example-plot("PacificTide PT07", 1.1, 0.05, 0.05, 0.3),
    example-plot("HarborBay-12 HB09", 2.4, 0.35, 0.15, 1.1),
    example-plot("Baltic-H station 41", 0.04, 0.0, 0.35, 2.0),
    example-plot("EstuaryNet station 17", 2.0, 0.55, 0.1, 0.7),
  ),
  caption: [Observed water level (black), #tf (blue) and PatchTST (dashed) 72-hour forecasts at four stations. Horizontal axis: hours after the forecast origin. Vertical axes are scaled individually.],
) <fig:examples>

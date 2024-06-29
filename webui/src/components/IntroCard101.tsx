import {Paper, Typography} from "@mui/material";
import {Link} from "react-router-dom";

export default function IntroCard101() {
    return (
        <Paper sx={{
            borderRadius: "10px",
            border: "2px solid #EBFF00",
            padding: "30px",
            maxWidth: "500px",
            zIndex: "1",
            background: "black",
        }}>
            <Link to={"/docs-petri-net-101"} style={{
                color: "white",
                textDecoration: "none",
            }}>
                <div style={{
                    textAlign: "center",
                    marginBottom: "20px",
                }}>
                    <svg width="107" height="107" viewBox="0 0 107 107" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path
                            d="M0 34.0587H5.6V39.6587H0V34.0587ZM0 39.6587H5.6V45.2587H0V39.6587ZM0 62.0787H5.6V67.6887H0V62.0787ZM0 67.6887H5.6V73.2887H0V67.6887ZM5.6 28.4487H11.2V34.0487H5.6V28.4487ZM5.6 34.0587H11.2V39.6587H5.6V34.0587ZM5.6 39.6587H11.2V45.2587H5.6V39.6587ZM5.6 45.2687H11.2V50.8687H5.6V45.2687ZM5.6 56.4787H11.2V62.0787H5.6V56.4787ZM5.6 62.0787H11.2V67.6887H5.6V62.0787ZM5.6 67.6887H11.2V73.2887H5.6V67.6887ZM5.6 73.2887H11.2V78.8987H5.6V73.2887ZM11.21 28.4487H16.81V34.0487H11.21V28.4487ZM11.21 34.0587H16.81V39.6587H11.21V34.0587ZM11.21 39.6587H16.81V45.2587H11.21V39.6587ZM11.21 45.2687H16.81V50.8687H11.21V45.2687ZM11.21 56.4787H16.81V62.0787H11.21V56.4787ZM11.21 62.0787H16.81V67.6887H11.21V62.0787ZM11.21 67.6887H16.81V73.2887H11.21V67.6887ZM11.21 73.2887H16.81V78.8987H11.21V73.2887ZM16.81 28.4487H22.41V34.0487H16.81V28.4487ZM16.81 34.0587H22.41V39.6587H16.81V34.0587ZM16.81 39.6587H22.41V45.2587H16.81V39.6587ZM16.81 45.2687H22.41V50.8687H16.81V45.2687ZM16.81 56.4787H22.41V62.0787H16.81V56.4787ZM16.81 62.0787H22.41V67.6887H16.81V62.0787ZM16.81 67.6887H22.41V73.2887H16.81V67.6887ZM16.81 73.2887H22.41V78.8987H16.81V73.2887ZM22.42 28.4487H28.03V34.0487H22.42V28.4487ZM22.42 34.0587H28.03V39.6587H22.42V34.0587ZM22.42 39.6587H28.03V45.2587H22.42V39.6587ZM22.42 45.2687H28.03V50.8687H22.42V45.2687ZM22.42 56.4787H28.03V62.0787H22.42V56.4787ZM22.42 62.0787H28.03V67.6887H22.42V62.0787ZM22.42 67.6887H28.03V73.2887H22.42V67.6887ZM22.42 73.2887H28.03V78.8987H22.42V73.2887ZM28.02 6.03871H33.62V11.6387H28.02V6.03871ZM28.02 11.6387H33.62V17.2487H28.02V11.6387ZM28.02 17.2387H33.62V22.8387H28.02V17.2387ZM28.02 22.8487H33.62V28.4587H28.02V22.8487ZM28.02 34.0587H33.62V39.6587H28.02V34.0587ZM28.02 39.6587H33.62V45.2587H28.02V39.6587ZM28.02 45.2687H33.62V50.8687H28.02V45.2687ZM28.02 56.4787H33.62V62.0787H28.02V56.4787ZM28.02 62.0787H33.62V67.6887H28.02V62.0787ZM28.02 67.6887H33.62V73.2887H28.02V67.6887ZM28.02 78.8887H33.62V84.4887H28.02V78.8887ZM28.02 84.4987H33.62V90.1087H28.02V84.4987ZM28.02 90.0987H33.62V95.6987H28.02V90.0987ZM28.02 95.7087H33.62V101.309H28.02V95.7087ZM33.63 0.428711H39.23V6.03871H33.63V0.428711ZM33.63 6.03871H39.23V11.6387H33.63V6.03871ZM33.63 11.6387H39.23V17.2487H33.63V11.6387ZM33.63 17.2387H39.23V22.8387H33.63V17.2387ZM33.63 22.8487H39.23V28.4587H33.63V22.8487ZM33.63 28.4487H39.23V34.0487H33.63V28.4487ZM33.63 39.6587H39.23V45.2587H33.63V39.6587ZM33.63 45.2687H39.23V50.8687H33.63V45.2687ZM33.63 50.8687H39.23V56.4687H33.63V50.8687ZM33.63 56.4787H39.23V62.0787H33.63V56.4787ZM33.63 62.0787H39.23V67.6887H33.63V62.0787ZM33.63 73.2887H39.23V78.8987H33.63V73.2887ZM33.63 78.8887H39.23V84.4887H33.63V78.8887ZM33.63 84.4987H39.23V90.1087H33.63V84.4987ZM33.63 90.0987H39.23V95.6987H33.63V90.0987ZM33.63 95.7087H39.23V101.309H33.63V95.7087ZM33.63 101.309H39.23V106.909H33.63V101.309ZM39.23 0.428711H44.83V6.03871H39.23V0.428711ZM39.23 6.03871H44.83V11.6387H39.23V6.03871ZM39.23 11.6387H44.83V17.2487H39.23V11.6387ZM39.23 17.2387H44.83V22.8387H39.23V17.2387ZM39.23 22.8487H44.83V28.4587H39.23V22.8487ZM39.23 28.4487H44.83V34.0487H39.23V28.4487ZM39.23 34.0587H44.83V39.6587H39.23V34.0587ZM39.23 39.6587H44.83V45.2587H39.23V39.6587ZM39.23 62.0787H44.83V67.6887H39.23V62.0787ZM39.23 67.6887H44.83V73.2887H39.23V67.6887ZM39.23 73.2887H44.83V78.8987H39.23V73.2887ZM39.23 78.8887H44.83V84.4887H39.23V78.8887ZM39.23 84.4987H44.83V90.1087H39.23V84.4987ZM39.23 90.0987H44.83V95.6987H39.23V90.0987ZM39.23 95.7087H44.83V101.309H39.23V95.7087ZM39.23 101.309H44.83V106.909H39.23V101.309ZM44.84 6.03871H50.44V11.6387H44.84V6.03871ZM44.84 11.6387H50.44V17.2487H44.84V11.6387ZM44.84 17.2387H50.44V22.8387H44.84V17.2387ZM44.84 22.8487H50.44V28.4587H44.84V22.8487ZM44.84 28.4487H50.44V34.0487H44.84V28.4487ZM44.84 34.0587H50.44V39.6587H44.84V34.0587ZM44.84 67.6887H50.44V73.2887H44.84V67.6887ZM44.84 73.2887H50.44V78.8987H44.84V73.2887ZM44.84 78.8887H50.44V84.4887H44.84V78.8887ZM44.84 84.4987H50.44V90.1087H44.84V84.4987ZM44.84 90.0987H50.44V95.6987H44.84V90.0987ZM44.84 95.7087H50.44V101.309H44.84V95.7087ZM50.44 34.0587H56.04V39.6587H50.44V34.0587ZM50.44 67.6887H56.04V73.2887H50.44V67.6887ZM56.05 6.03871H61.65V11.6387H56.05V6.03871ZM56.05 11.6387H61.65V17.2487H56.05V11.6387ZM56.05 17.2387H61.65V22.8387H56.05V17.2387ZM56.05 22.8487H61.65V28.4587H56.05V22.8487ZM56.05 28.4487H61.65V34.0487H56.05V28.4487ZM56.05 34.0587H61.65V39.6587H56.05V34.0587ZM56.05 67.6887H61.65V73.2887H56.05V67.6887ZM56.05 73.2887H61.65V78.8987H56.05V73.2887ZM56.05 78.8887H61.65V84.4887H56.05V78.8887ZM56.05 84.4987H61.65V90.1087H56.05V84.4987ZM56.05 90.0987H61.65V95.6987H56.05V90.0987ZM56.05 95.7087H61.65V101.309H56.05V95.7087ZM61.65 0.428711H67.25V6.03871H61.65V0.428711ZM61.65 6.03871H67.25V11.6387H61.65V6.03871ZM61.65 11.6387H67.25V17.2487H61.65V11.6387ZM61.65 17.2387H67.25V22.8387H61.65V17.2387ZM61.65 22.8487H67.25V28.4587H61.65V22.8487ZM61.65 28.4487H67.25V34.0487H61.65V28.4487ZM61.65 34.0587H67.25V39.6587H61.65V34.0587ZM61.65 39.6587H67.25V45.2587H61.65V39.6587ZM61.65 62.0787H67.25V67.6887H61.65V62.0787ZM61.65 67.6887H67.25V73.2887H61.65V67.6887ZM61.65 73.2887H67.25V78.8987H61.65V73.2887ZM61.65 78.8887H67.25V84.4887H61.65V78.8887ZM61.65 84.4987H67.25V90.1087H61.65V84.4987ZM61.65 90.0987H67.25V95.6987H61.65V90.0987ZM61.65 95.7087H67.25V101.309H61.65V95.7087ZM61.65 101.309H67.25V106.909H61.65V101.309ZM67.25 0.428711H72.85V6.03871H67.25V0.428711ZM67.25 6.03871H72.85V11.6387H67.25V6.03871ZM67.25 11.6387H72.85V17.2487H67.25V11.6387ZM67.25 17.2387H72.85V22.8387H67.25V17.2387ZM67.25 22.8487H72.85V28.4587H67.25V22.8487ZM67.25 28.4487H72.85V34.0487H67.25V28.4487ZM67.25 39.6587H72.85V45.2587H67.25V39.6587ZM67.25 45.2687H72.85V50.8687H67.25V45.2687ZM67.25 50.8687H72.85V56.4687H67.25V50.8687ZM67.25 56.4787H72.85V62.0787H67.25V56.4787ZM67.25 62.0787H72.85V67.6887H67.25V62.0787ZM67.25 73.2887H72.85V78.8987H67.25V73.2887ZM67.25 78.8887H72.85V84.4887H67.25V78.8887ZM67.25 84.4987H72.85V90.1087H67.25V84.4987ZM67.25 90.0987H72.85V95.6987H67.25V90.0987ZM67.25 95.7087H72.85V101.309H67.25V95.7087ZM67.25 101.309H72.85V106.909H67.25V101.309ZM72.86 6.03871H78.46V11.6387H72.86V6.03871ZM72.86 11.6387H78.46V17.2487H72.86V11.6387ZM72.86 17.2387H78.46V22.8387H72.86V17.2387ZM72.86 22.8487H78.46V28.4587H72.86V22.8487ZM72.86 34.0587H78.46V39.6587H72.86V34.0587ZM72.86 39.6587H78.46V45.2587H72.86V39.6587ZM72.86 45.2687H78.46V50.8687H72.86V45.2687ZM72.86 56.4787H78.46V62.0787H72.86V56.4787ZM72.86 62.0787H78.46V67.6887H72.86V62.0787ZM72.86 67.6887H78.46V73.2887H72.86V67.6887ZM72.86 78.8887H78.46V84.4887H72.86V78.8887ZM72.86 84.4987H78.46V90.1087H72.86V84.4987ZM72.86 90.0987H78.46V95.6987H72.86V90.0987ZM72.86 95.7087H78.46V101.309H72.86V95.7087ZM78.46 28.4487H84.06V34.0487H78.46V28.4487ZM78.46 34.0587H84.06V39.6587H78.46V34.0587ZM78.46 39.6587H84.06V45.2587H78.46V39.6587ZM78.46 45.2687H84.06V50.8687H78.46V45.2687ZM78.46 56.4787H84.06V62.0787H78.46V56.4787ZM78.46 62.0787H84.06V67.6887H78.46V62.0787ZM78.46 67.6887H84.06V73.2887H78.46V67.6887ZM78.46 73.2887H84.06V78.8987H78.46V73.2887ZM84.07 28.4487H89.68V34.0487H84.07V28.4487ZM84.07 34.0587H89.68V39.6587H84.07V34.0587ZM84.07 39.6587H89.68V45.2587H84.07V39.6587ZM84.07 45.2687H89.68V50.8687H84.07V45.2687ZM84.07 56.4787H89.68V62.0787H84.07V56.4787ZM84.07 62.0787H89.68V67.6887H84.07V62.0787ZM84.07 67.6887H89.68V73.2887H84.07V67.6887ZM84.07 73.2887H89.68V78.8987H84.07V73.2887ZM89.67 28.4487H95.27V34.0487H89.67V28.4487ZM89.67 34.0587H95.27V39.6587H89.67V34.0587ZM89.67 39.6587H95.27V45.2587H89.67V39.6587ZM89.67 45.2687H95.27V50.8687H89.67V45.2687ZM89.67 56.4787H95.27V62.0787H89.67V56.4787ZM89.67 62.0787H95.27V67.6887H89.67V62.0787ZM89.67 67.6887H95.27V73.2887H89.67V67.6887ZM89.67 73.2887H95.27V78.8987H89.67V73.2887ZM95.28 28.4487H100.88V34.0487H95.28V28.4487ZM95.28 34.0587H100.88V39.6587H95.28V34.0587ZM95.28 39.6587H100.88V45.2587H95.28V39.6587ZM95.28 45.2687H100.88V50.8687H95.28V45.2687ZM95.28 56.4787H100.88V62.0787H95.28V56.4787ZM95.28 62.0787H100.88V67.6887H95.28V62.0787ZM95.28 67.6887H100.88V73.2887H95.28V67.6887ZM95.28 73.2887H100.88V78.8987H95.28V73.2887ZM100.88 34.0587H106.48V39.6587H100.88V34.0587ZM100.88 39.6587H106.48V45.2587H100.88V39.6587ZM100.88 62.0787H106.48V67.6887H100.88V62.0787ZM100.88 67.6887H106.48V73.2887H100.88V67.6887Z"
                            fill="#EBFF00"/>
                    </svg>
                </div>
                <Typography sx={{
                    fontFamily: "GT_America-Light",
                    fontSize: "22px",
                    fontWeight: "600",
                }}>
                    Learn more! <br/>Petri-Net 101
                </Typography>
            </Link>
        </Paper>
    )
}
